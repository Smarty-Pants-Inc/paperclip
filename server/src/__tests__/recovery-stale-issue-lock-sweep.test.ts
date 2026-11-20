import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "../services/heartbeat/queue.js";
import { registerDeferredReceiptWork } from "../services/heartbeat/deferred-receipt-work.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { wiredHeartbeatFor } from "../services/heartbeat-registry.js";
import { reconcileNativeFinalizations } from "../services/native-runtime/native-finalization-reconciler.js";
import { pendingNativeWithheldReply } from "../services/native-runtime/native-withheld-reply-trigger.js";
import { nativeResponsePresentationWork } from "../services/native-runtime/native-response-presentation-work.js";
import { workspaceOperations, issueRecoveryActions } from "@paperclipai/db";
import { nativeWorkspaceFinalizationWork } from "../services/native-runtime/native-workspace-finalization-work.js";
import { recordNativeWorkspaceFinalizationFailure } from "../services/native-runtime/native-workspace-finalizer.js";
import { taskInterruptionPresentation } from "../services/task-interruption-presentation.js";
import { persistHeartbeatRunProcessMetadata } from "../services/heartbeat/run-lifecycle.js";
import { currentProcessSpaceHash } from "../services/controller-process-identity.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { chatCompletionDeliveryService } from "../services/chat-completion-delivery.js";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { settleOwnableKind } from "../services/recovery/ownership-invariant-report.js";
import {
  subscribeDatabaseWork,
  agentRuntimeState,
  costEvents,
  activityLog,
  agents,
  authUsers,
  companyMemberships,
  agentWakeupRequests,
  companies,
  chatCompletionDeliveries,
  chatTaskHandoffs,
  completionContracts,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import { deliverConversationComments, settleConversationTurn } from "../services/agent-conversations.js";
import { issueService } from "../services/issues.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { recoveryService } from "../services/recovery/service.ts";
import { instanceSettingsService } from "../services/instance-settings.js";
import { settleUnansweredPersonMessage } from "../services/recovery/unanswered-person-message.js";
import { withQueuedCommentIdsInWakePayload } from "../services/issue-queued-comment-queue.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { createAdmissionTransactionScope, createWakeAdmissionWriter, createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_STALE_LOCK_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("recovery sweepStaleIssueLocks", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-lock-sweep-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockTelemetryClient.track.mockClear();
    await db.delete(nativeRunFinalizations);
    await db.delete(nativeRunResults);
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  it("renders the Stop-pending schema in the ordinary recovery writer guard", async () => {
    // Keep the sweep's real import order: a module-initialization cycle can
    // capture undefined here even though the exported schema is defined later.
    const renderedGuards: string[] = [];
    const render = PgDialect.prototype.sqlToQuery;
    const spy = vi.spyOn(PgDialect.prototype, "sqlToQuery").mockImplementation(function (this: PgDialect, query, source) {
      const rendered = render.call(this, sql`${query}`.inlineParams(), source).sql;
      if (rendered.includes("->'stopPending'->>'schema'")) renderedGuards.push(rendered);
      return render.call(this, query, source);
    });
    try {
      await issueRecoveryActionService(db).resolveActiveForIssue({
        companyId: randomUUID(), sourceIssueId: randomUUID(), status: "resolved", outcome: "restored",
      });
    } finally {
      spy.mockRestore();
      expect(renderedGuards.join("\n")).toContain("<> 'paperclip.task-stop-pending.v1'");
    }
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const failedRunId = randomUUID();
    const runningRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: failedRunId,
        companyId,
        agentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: new Date(),
      },
      {
        id: runningRunId,
        companyId,
        agentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, agentId, failedRunId, runningRunId };
  }

  it.each([true, false])("preserves explicit retry ownership when finalization wins the sweep write (settler: %s)", async withSettler => {
    const { companyId, agentId, runningRunId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry finalization race",
      status: "in_progress", assigneeAgentId: agentId, executionRunId: runningRunId });
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000,
      contextSnapshot: { issueId, explicitUserContinuation: { previousRunId: failedRunId, commentId: randomUUID() } },
    }).where(eq(heartbeatRuns.id, runningRunId));
    // The sweep hands the legacy run to the one lost-process settle path;
    // finalization wins that race and records the run timed out.
    const settleLostRunProcess = vi.fn(async () => {
      await db.update(heartbeatRuns).set({ status: "timed_out", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, runningRunId));
    });
    const settleExplicitContinuationRetry = vi.fn(async () => {});
    const result = await recoveryService(db, { enqueueWakeup: vi.fn(), settleLostRunProcess,
      ...(withSettler ? { settleExplicitContinuationRetry } : {}),
    }).sweepStaleIssueLocks();
    expect(settleLostRunProcess).toHaveBeenCalledOnce();
    // The sweep reads the outcome back and never clears the retry's lock.
    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [runningRunId] });
    expect(settleExplicitContinuationRetry).toHaveBeenCalledTimes(withSettler ? 1 : 0);
    if (withSettler) expect(settleExplicitContinuationRetry).toHaveBeenCalledWith(expect.objectContaining({
      id: runningRunId, status: "timed_out",
    }));
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]!.executionRunId).toBe(runningRunId);
  });

  // Section E: clearing a stale lock is a hold-release event. A message saved
  // behind the lock is made due at once instead of waiting out its backoff.
  it("promotes a message saved behind a stale lock when the sweep clears it", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved behind a stale lock", status: "in_progress",
      priority: "high", assigneeAgentId: agentId, checkoutRunId: failedRunId, executionRunId: failedRunId });
    const [saved] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      status: "deferred_issue_execution", requestedByActorType: "user", updatedAt: new Date(),
      payload: { issueId, executionWait: { reason: "company.inactive", trigger: "pause_lifted" } } }).returning();
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks({ companyId, issueId });
    expect(result.issueIds).toEqual([issueId]);
    const [after] = await db.select({ updatedAt: agentWakeupRequests.updatedAt }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, saved.id));
    expect(after.updatedAt.getTime()).toBeLessThanOrEqual(Date.now() - 29_000);
  });

  it("does not promote a saved message when the guarded clear keeps the lock", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Lock taken back", status: "in_progress",
      priority: "high", assigneeAgentId: agentId, checkoutRunId: failedRunId, executionRunId: failedRunId });
    const savedAt = new Date();
    const [saved] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      status: "deferred_issue_execution", requestedByActorType: "user", updatedAt: savedAt,
      payload: { issueId, executionWait: { reason: "company.inactive", trigger: "pause_lifted" } } }).returning();
    // A resume returns the run to running after the sweep read it.
    const beforeStaleLockClear = vi.fn(async () => {
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, failedRunId));
    });
    const result = await recoveryService(db, { enqueueWakeup: vi.fn(), beforeStaleLockClear }).sweepStaleIssueLocks({ companyId, issueId });
    expect(result.issueIds).toEqual([]);
    const [after] = await db.select({ updatedAt: agentWakeupRequests.updatedAt }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, saved.id));
    expect(after.updatedAt.getTime()).toBe(savedAt.getTime());
  });

  it("clears lock columns when checkoutRunId points at a terminal heartbeat run", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stale lock — terminal checkoutRunId",
      // Status off in_progress + checkoutRunId still set → exactly the recurrence shape.
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(1);
    expect(result.issueIds).toEqual([issueId]);

    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: null, executionRunId: null, executionLockedAt: null });

    const audit = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.stale_lock_cleared"))
      .then((rows) => rows[0]);
    expect(audit?.action).toBe("issue.stale_lock_cleared");
    expect((audit?.details as { clearedCheckoutRunId?: string } | null)?.clearedCheckoutRunId).toBe(
      failedRunId,
    );
  });

  it("does not clear locks while the referenced run is still running", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live lock — must be preserved",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not terminalize a session-goal control run solely because its issue is done", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        contextSnapshot: {
          issueId,
          resumeIntent: true,
          goalControlRequestId: randomUUID(),
          runnerGoalControl: { action: "clear" },
        },
      })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completed goal awaiting clear",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const result = await heartbeatService(db).sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);
    await expect(
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runningRunId))
        .then((rows) => rows[0]?.status),
    ).resolves.toBe("running");
  });

  async function seedCompletedOnboardingReport(options: {
    runtimeMode?: "native" | "legacy";
    variant?: "ordinary" | "cancelled" | "wrong_child" | "wrong_reason" | "wrong_agent" | "unfinished_child" | "foreign_child";
  } = {}) {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    const childIssueId = randomUUID();
    const variant = options.variant;
    let childCompanyId = companyId;
    if (variant === "foreign_child") {
      childCompanyId = randomUUID();
      await db.insert(companies).values({
        id: childCompanyId,
        name: "Other company",
        issuePrefix: `T${childCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Completed onboarding awaiting its child result",
      originKind: variant === "ordinary" ? "manual" : "onboarding_first_task",
      status: variant === "cancelled" ? "cancelled" : "done",
      assigneeAgentId: variant === "wrong_agent" ? null : agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId: childCompanyId,
      title: "Accepted child output",
      status: variant === "unfinished_child" ? "in_progress" : "done",
      parentId: variant === "foreign_child" ? null : issueId,
    });
    await db.update(heartbeatRuns).set({
      runtimeMode: options.runtimeMode ?? "native",
      nativeIssueId: options.runtimeMode === "legacy" ? null : issueId,
      processPid: 2_000_000_000,
      contextSnapshot: {
        issueId,
        wakeReason: variant === "wrong_reason" ? "issue_commented" : "issue_children_completed",
        completedChildIssueId: variant === "wrong_child" ? randomUUID() : childIssueId,
        onboardingCompletion: true,
      },
    }).where(eq(heartbeatRuns.id, runningRunId));
    return { companyId, agentId, issueId, childIssueId, runningRunId };
  }

  it.each(["native", "legacy"] as const)("preserves a live %s completed-onboarding reporting turn during delayed startup", async runtimeMode => {
    const { issueId, runningRunId } = await seedCompletedOnboardingReport({ runtimeMode });
    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn(),
      liveRunExecutions: new Set([runningRunId]),
    }).sweepStaleIssueLocks();

    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId)))[0]?.status).toBe("running");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({
      status: "done", checkoutRunId: runningRunId, executionRunId: runningRunId,
    });
    expect(mockTelemetryClient.track).not.toHaveBeenCalled();
  });

  it.each(["ordinary", "cancelled", "wrong_child", "wrong_reason", "wrong_agent", "unfinished_child", "foreign_child"] as const)("does not exempt an invalid completed-onboarding reporting turn (%s)", async variant => {
    const { issueId, runningRunId } = await seedCompletedOnboardingReport({ variant });
    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn(),
      liveRunExecutions: new Set([runningRunId]),
    }).sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId)))[0]?.status).toBe(variant === "cancelled" ? "cancelled" : "succeeded");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ checkoutRunId: null, executionRunId: null });
  });

  it("still interrupts a completed-onboarding reporting turn after its process and execution owner are gone", async () => {
    const { issueId, runningRunId } = await seedCompletedOnboardingReport();
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId)))[0]).toMatchObject({
      status: "interrupted", errorCode: "orphaned_running_run",
    });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ checkoutRunId: null, executionRunId: null });
  });

  it("does not clear when checkoutRunId is terminal but executionRunId is still running", async () => {
    const { companyId, agentId, failedRunId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Mixed lock — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.cleared).toBe(0);
    const row = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ checkoutRunId: failedRunId, executionRunId: runningRunId });
  });

  it("is idempotent — second pass finds nothing to clear", async () => {
    const { companyId, agentId, failedRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Idempotency",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: failedRunId,
      executionRunId: null,
    });

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.sweepStaleIssueLocks();
    const second = await heartbeat.sweepStaleIssueLocks();
    expect(first.cleared).toBe(1);
    expect(second.cleared).toBe(0);
  });

  it.each([[false, true], [true, false]] as const)(
    "judges a pre-upgrade pid with no recorded space only on a single-host server (ephemeral: %s)", async (ephemeral, terminalized) => {
    vi.stubEnv("PAPERCLIP_EPHEMERAL_SERVER", ephemeral ? "true" : "");
    try {
      const { companyId, agentId, runningRunId } = await seed();
      await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, processHostHash: null })
        .where(eq(heartbeatRuns.id, runningRunId));
      await db.insert(issues).values({ id: randomUUID(), companyId, title: "Pre-upgrade orphan", status: "in_progress",
        priority: "high", assigneeAgentId: agentId, checkoutRunId: runningRunId, executionRunId: runningRunId,
        executionLockedAt: new Date() });
      const result = await heartbeatService(db).sweepStaleIssueLocks();
      expect(result.terminalizedRunIds.includes(runningRunId)).toBe(terminalized);
      const events = await db.select({ details: activityLog.details }).from(activityLog)
        .where(and(eq(activityLog.runId, runningRunId), eq(activityLog.action, "legacy_host_unknown_dead_pid_proof")));
      expect(events).toHaveLength(terminalized ? 1 : 0);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([["local", true], ["remote", false]] as const)("stamps a %s process pid with its PID space", async (targetKind, local) => {
    const { runningRunId } = await seed();
    await persistHeartbeatRunProcessMetadata(db, runningRunId, { pid: process.pid, processGroupId: null,
      startedAt: new Date().toISOString(), targetKind });
    const [run] = await db.select({ processHostHash: heartbeatRuns.processHostHash }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId));
    expect(run?.processHostHash).toBe(local ? currentProcessSpaceHash() : "remote");
  });

  it.each([
    ["another host", "another-host-pid-space", false],
    ["a sandbox", "remote", false],
    ["an unreadable PID space", "unknown", false],
    ["this PID space", "current", true],
  ] as const)("judges a dead recorded pid only in its own PID space (%s)", async (_name, space, terminalized) => {
    const { companyId, agentId, runningRunId } = await seed();
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000,
      processHostHash: space === "current" ? currentProcessSpaceHash() : space })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values({ id: randomUUID(), companyId, title: "Cross-host orphan", status: "in_progress",
      priority: "high", assigneeAgentId: agentId, checkoutRunId: runningRunId, executionRunId: runningRunId,
      executionLockedAt: new Date() });
    const result = await heartbeatService(db).sweepStaleIssueLocks();
    expect(result.terminalizedRunIds.includes(runningRunId)).toBe(terminalized);
    const [run] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));
    // A legacy run with a proven-gone child gets the one lost-process
    // reaper's outcome; an unprovable one stays running (Stop releases it).
    expect(run?.status).toBe(terminalized ? "failed" : "running");
  });

  it("terminalizes an orphaned running native run whose process is gone, then clears the lock", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // The run recorded a pid, but the process and its sandbox are gone. A pid
    // this large never maps to a live process, so the prover finds it gone.
    // The issue is not terminal, so only the process-death authority applies.
    await db
      .update(heartbeatRuns)
      .set({ processPid: 2_000_000_000, runtimeMode: "native" })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Orphaned running run — terminalize then clear",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(1);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]);
    // Process died, outcome unknown, so the backstop uses "interrupted".
    expect(run?.status).toBe("interrupted");
    expect(run?.errorCode).toBe("orphaned_running_run");

    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    const event = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("process and sandbox gone");

    // The recovery sweep's own terminal write must emit exactly one
    // agent.task_run event for the run it just terminalized. The write
    // never awaits the emission, so wait for it here instead of asserting
    // it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTelemetryClient.track).toHaveBeenCalledTimes(1);
    });
    expect(mockTelemetryClient.track).toHaveBeenCalledWith(
      "agent.task_run",
      expect.objectContaining({ agent_id: agentId, state: "interrupted" }),
    );
  });

  it.each(["in_progress", "done"])("preserves a live legacy controller lease when the issue is %s", async (status) => {
    const { companyId, agentId, runningRunId } = await seed();
    await db.update(heartbeatRuns).set({
      runtimeMode: "legacy", processPid: 2_000_000_000,
      controllerBootId: randomUUID(),
      controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
    }).where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Remote controller still owns the run", status,
      assigneeAgentId: agentId, executionRunId: runningRunId, checkoutRunId: runningRunId,
    });
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "running" }]);
    expect(await db.select({ executionRunId: issues.executionRunId }).from(issues)
      .where(eq(issues.id, issueId))).toEqual([{ executionRunId: runningRunId }]);
  });

  it.each(["renew", "replace", "claim"])("fences a legacy controller %s between the orphan check and terminal write", async (change) => {
    const { companyId, agentId, runningRunId } = await seed();
    const bootId = randomUUID();
    await db.update(heartbeatRuns).set({
      runtimeMode: "legacy", processPid: 2_000_000_000,
      controllerBootId: change === "claim" ? null : bootId,
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values({
      id: randomUUID(), companyId, title: "Controller changed during sweep", status: "in_progress",
      assigneeAgentId: agentId, executionRunId: runningRunId, checkoutRunId: runningRunId,
    });
    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn(),
      beforeOrphanedRunTerminalWrite: async () => {
        await db.update(heartbeatRuns).set({
          controllerBootId: change === "renew" ? bootId : randomUUID(),
          // A replacement invalidates the old snapshot even if its lease expires.
          controllerLeaseExpiresAt: new Date(Date.now() + (change === "replace" ? -30_000 : 60_000)),
        }).where(eq(heartbeatRuns.id, runningRunId));
      },
    }).sweepStaleIssueLocks();
    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "running" }]);
    expect(mockTelemetryClient.track).not.toHaveBeenCalled();
  });

  it("preserves a process-less native run while same-run resumption owns its retry", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native same-run retry remains live",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeIssueId: issueId,
        nativePhase: "retryable_failure",
        processPid: 2_000_000_000,
      })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(nativeRunFinalizations).values({
      runId: runningRunId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      nextAttemptAt: new Date(Date.now() + 30_000),
    });

    const result = await heartbeatService(db).sweepStaleIssueLocks();

    expect(result).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
    await expect(db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId)))
      .resolves.toEqual([{ status: "running" }]);
    await expect(db.select({
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ checkoutRunId: runningRunId, executionRunId: runningRunId }]);
  });

  async function seedPendingNativeResult(phase: string, options: { terminalIssue?: boolean; deferCoordinator?: boolean } = {}) {
    const fixture = await seed();
    const { companyId, agentId, runningRunId } = fixture;
    const issueId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    await db.insert(issues).values({
      id: issueId, companyId, title: "Workspace finalization fixture",
      status: options.terminalIssue ? "done" : "in_progress", assigneeAgentId: agentId,
      executionRunId: runningRunId, checkoutRunId: runningRunId,
    });
    await db.insert(completionContracts).values({
      id: contractId, companyId, issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture",
      risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: "fixture-contract", createdByActorType: "system", createdByActorId: "test",
    });
    await db.update(heartbeatRuns).set({
      runtimeMode: "native", nativeIssueId: issueId, nativePhase: phase,
      processPid: 2_000_000_000, completionContractId: contractId,
    }).where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(nativeRunResults).values({
      id: resultId, companyId, issueId, runId: runningRunId, completionContractId: contractId,
      serverFingerprint: "fixture-result", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "fixture-result",
    });
    const recordCoordinator = () => db.insert(nativeRunFinalizations).values({
      runId: runningRunId, companyId, issueId, phase, resultId, attempt: 1,
      nextAttemptAt: new Date(Date.now() + 30_000),
      leaseOwner: "previous-controller", leaseExpiresAt: new Date(Date.now() - 30_000),
    });
    if (!options.deferCoordinator) await recordCoordinator();
    return { ...fixture, issueId, recordCoordinator };
  }

  it.each(["observed", "workspace_finalizing", "ready_for_assessment", "arbitrating", "retryable_failure"])(
    "preserves a completed native result in %s after its provider exits", async phase => {
      const { runningRunId, issueId } = await seedPendingNativeResult(phase);
      const events: string[] = [];
      const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => events.push(event));
      try {
        const recovery = recoveryService(db, { enqueueWakeup: vi.fn() });
        for (let pass = 0; pass < 3; pass++) {
          expect(await recovery.sweepStaleIssueLocks()).toEqual({ cleared: 0, issueIds: [], terminalizedRunIds: [] });
        }
        expect(events).toEqual([]);
      } finally { unsubscribe(); }
      expect(await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "running", errorCode: null }]);
      expect(await db.select({ executionRunId: issues.executionRunId }).from(issues)
        .where(eq(issues.id, issueId))).toEqual([{ executionRunId: runningRunId }]);
      expect(mockTelemetryClient.track).not.toHaveBeenCalled();
    },
  );

  it("rechecks native finalization ownership when the coordinator appears after the liveness read", async () => {
    const { runningRunId, recordCoordinator } = await seedPendingNativeResult("retryable_failure", { deferCoordinator: true });
    const beforeOrphanedRunTerminalWrite = vi.fn(async () => { await recordCoordinator(); });
    const result = await recoveryService(db, { enqueueWakeup: vi.fn(), beforeOrphanedRunTerminalWrite }).sweepStaleIssueLocks();
    expect(beforeOrphanedRunTerminalWrite).toHaveBeenCalledOnce();
    expect(result.terminalizedRunIds).toEqual([]);
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "running" }]);
  });

  it("still respects terminal issue authority while workspace finalization is pending", async () => {
    const { runningRunId } = await seedPendingNativeResult("retryable_failure", { terminalIssue: true });
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(result.terminalizedRunIds).toContain(runningRunId);
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "succeeded" }]);
  });

  it("does not keep an orphan live after native finalization exhausts its retries", async () => {
    const { runningRunId } = await seedPendingNativeResult("terminal_failure");
    const result = await recoveryService(db, { enqueueWakeup: vi.fn() }).sweepStaleIssueLocks();
    expect(result.terminalizedRunIds).toContain(runningRunId);
    expect(await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))).toEqual([{ status: "interrupted" }]);
  });

  it("preserves a process-less run while its in-process execution is still finalizing", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native finalization remains live",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        processPid: 2_000_000_000,
      })
      .where(eq(heartbeatRuns.id, runningRunId));

    const result = await recoveryService(db, {
      enqueueWakeup: vi.fn(),
      liveRunExecutions: new Set([runningRunId]),
    }).sweepStaleIssueLocks();

    expect(result).toEqual({
      cleared: 0,
      issueIds: [],
      terminalizedRunIds: [],
    });
    await expect(db.select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId)))
      .resolves.toEqual([{ status: "running" }]);
    await expect(db.select({
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
    }).from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ checkoutRunId: runningRunId, executionRunId: runningRunId }]);
  });

  it("terminalizes a running run whose issue is terminal but retains claims while the process stays alive (reuse-lease path)", async () => {
    // Terminal task authority still settles the run's status, but cannot prove
    // execution Stop while its recorded PID is alive. Keep both claims until
    // the execution evidence is released, even when the task is already done.
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reused sandbox stopped — issue done, run still running",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    expect(result.cleared).toBe(0);

    const run = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]);
    // The issue is "done", so the terminal run status is "succeeded". A
    // succeeded run carries no error code.
    expect(run?.status).toBe("succeeded");
    expect(run?.errorCode).toBeNull();

    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });

    const event = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId))
      .then((rows) => rows[0]);
    expect(event?.message).toContain("issue reached a terminal status");

    // The terminal write never awaits the telemetry emission, so wait for
    // it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTelemetryClient.track).toHaveBeenCalledTimes(1);
    });
    expect(mockTelemetryClient.track).toHaveBeenCalledWith(
      "agent.task_run",
      expect.objectContaining({ agent_id: agentId, state: "succeeded" }),
    );

    await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, runningRunId));
    expect((await heartbeat.sweepStaleIssueLocks()).cleared).toBe(1);
    await expect(db.select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, issueId)))
      .resolves.toEqual([{ checkoutRunId: null, executionRunId: null }]);
  });

  it("terminalizes a running run to cancelled when its issue is cancelled (reuse-lease path)", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reused sandbox stopped — issue cancelled, run still running",
      status: "cancelled",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([runningRunId]);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("cancelled");

    // The terminal write never awaits the telemetry emission, so wait for
    // it here instead of asserting it fired synchronously.
    await vi.waitFor(() => {
      expect(mockTelemetryClient.track).toHaveBeenCalledTimes(1);
    });
    expect(mockTelemetryClient.track).toHaveBeenCalledWith(
      "agent.task_run",
      expect.objectContaining({ agent_id: agentId, state: "cancelled" }),
    );
  });

  it("does not terminalize a running run whose process is alive and whose issue is not terminal", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Live run — preserve",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");

    // No terminal write happened, so no telemetry event fires.
    expect(mockTelemetryClient.track).not.toHaveBeenCalled();
  });

  it("does not terminalize or clear issue locks when an ownership hold arrives after the sweep snapshot", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    const issueId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        runtimeMode: "native",
        nativeIssueId: issueId,
        processPid: process.pid,
      })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Ownership hold races stale issue-lock recovery",
      status: "done",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    let releaseTerminalWrite!: () => void;
    const terminalWriteReleased = new Promise<void>((resolve) => {
      releaseTerminalWrite = resolve;
    });
    let terminalWriteReached!: () => void;
    const atTerminalWrite = new Promise<void>((resolve) => {
      terminalWriteReached = resolve;
    });
    const sweep = recoveryService(db, {
      enqueueWakeup: vi.fn(),
      beforeOrphanedRunTerminalWrite: async (runId) => {
        if (runId !== runningRunId) return;
        terminalWriteReached();
        await terminalWriteReleased;
      },
    }).sweepStaleIssueLocks();

    try {
      await atTerminalWrite;
      await db
        .update(heartbeatRuns)
        .set({
          nativePhase: "terminal_failure",
          errorCode: "native_execution_ownership_unverified",
        })
        .where(eq(heartbeatRuns.id, runningRunId));
    } finally {
      releaseTerminalWrite();
    }

    await expect(sweep).resolves.toEqual({
      cleared: 0,
      issueIds: [],
      terminalizedRunIds: [],
    });
    await expect(
      db
        .select({
          status: heartbeatRuns.status,
          nativePhase: heartbeatRuns.nativePhase,
          errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runningRunId)),
    ).resolves.toEqual([
      {
        status: "running",
        nativePhase: "terminal_failure",
        errorCode: "native_execution_ownership_unverified",
      },
    ]);
    await expect(
      db
        .select({
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId)),
    ).resolves.toEqual([
      {
        checkoutRunId: runningRunId,
        executionRunId: runningRunId,
      },
    ]);
    expect(mockTelemetryClient.track).not.toHaveBeenCalled();
  });

  it("does not terminalize a live run that a terminal issue and an active issue both reference", async () => {
    // A stale lock on a terminal issue and the real lock on an active issue can
    // point at the same running run. The terminal reference alone must not
    // terminalize the run, because the run is still live for the active issue.
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));

    const terminalIssueId = randomUUID();
    const activeIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: terminalIssueId,
        companyId,
        title: "Terminal issue holds a stale lock on the shared run",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: null,
      },
      {
        id: activeIssueId,
        companyId,
        title: "Active issue owns the live shared run",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: runningRunId,
        executionLockedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    // The run stays live, so the sweep terminalizes nothing and clears nothing.
    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");

    const activeLock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, activeIssueId))
      .then((rows) => rows[0]);
    expect(activeLock).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  it("does not terminalize a shared live run when its context snapshot names the terminal issue", async () => {
    // The run context snapshot names the terminal issue. The context-snapshot
    // fallback in terminalizeOrphanedRunningRun could read that terminal status
    // and terminalize the run. An active issue still owns the run, so the sweep
    // must suppress the fallback and keep the run live.
    const { companyId, agentId, runningRunId } = await seed();
    // process.pid is the live test process, so isPidAlive returns true.
    await db
      .update(heartbeatRuns)
      .set({ processPid: process.pid })
      .where(eq(heartbeatRuns.id, runningRunId));

    const terminalIssueId = randomUUID();
    const activeIssueId = randomUUID();
    // The run context snapshot names the terminal issue. This is the path the
    // shared-run guard must still block.
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot: { issueId: terminalIssueId } })
      .where(eq(heartbeatRuns.id, runningRunId));
    await db.insert(issues).values([
      {
        id: terminalIssueId,
        companyId,
        title: "Terminal issue named in the run context snapshot",
        status: "done",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: null,
      },
      {
        id: activeIssueId,
        companyId,
        title: "Active issue owns the live shared run",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
        checkoutRunId: runningRunId,
        executionRunId: runningRunId,
        executionLockedAt: new Date(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const result = await heartbeat.sweepStaleIssueLocks();

    // The run stays live, so the sweep terminalizes nothing and clears nothing.
    expect(result.terminalizedRunIds).toEqual([]);
    expect(result.cleared).toBe(0);

    const runStatus = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]?.status);
    expect(runStatus).toBe("running");

    const activeLock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, activeIssueId))
      .then((rows) => rows[0]);
    expect(activeLock).toEqual({ checkoutRunId: runningRunId, executionRunId: runningRunId });
  });

  // One lost-process reaper (Phase 3, non-wake recovery): the orphan sweep no
  // longer judges a legacy child itself. It hands the run to the
  // active-execution reaper, so the run gets that reaper's failed/process_lost
  // outcome and retry policy, with no age guard once the child is proven gone,
  // and the dead run no longer holds the task.
  it("hands a legacy run whose child is proven gone to the one lost-process reaper", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, processHostHash: currentProcessSpaceHash(),
      updatedAt: new Date() }).where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Lost legacy child", status: "in_progress",
      priority: "high", assigneeAgentId: agentId, checkoutRunId: runningRunId, executionRunId: runningRunId,
      executionLockedAt: new Date() });
    const result = await heartbeatService(db).sweepStaleIssueLocks();
    expect(result.terminalizedRunIds).toEqual([runningRunId]);
    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));
    expect(run).toEqual({ status: "failed", errorCode: "process_lost" });
    const [lock] = await db.select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues).where(eq(issues.id, issueId));
    expect(lock.checkoutRunId).not.toBe(runningRunId);
    expect(lock.executionRunId).not.toBe(runningRunId);
  });

  // RC-27: the reaper waited out a 5-minute age guard even when the shared
  // prover could already show the legacy child was gone. Age is never proof.
  it("settles a legacy run whose child is proven gone without waiting out the age guard", async () => {
    const { runningRunId } = await seed();
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, processHostHash: currentProcessSpaceHash(),
      updatedAt: new Date() }).where(eq(heartbeatRuns.id, runningRunId));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 5 * 60_000 });
    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));
    expect(run).toEqual({ status: "failed", errorCode: "process_lost" });
  });

  // Greptile on #20004: the reaper proved children only for session adapters,
  // so a handed-over `process` run with a live child fell through to
  // process_lost once the age guard passed.
  it("never releases a process-adapter run whose recorded child is still alive", async () => {
    const { agentId, runningRunId } = await seed();
    await db.update(agents).set({ adapterType: "process" }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ processPid: process.pid, processHostHash: currentProcessSpaceHash(),
      updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, runningRunId));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 5 * 60_000 });
    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));
    expect(run).toEqual({ status: "running", errorCode: "process_detached" });
  });

  it("never releases a legacy run whose child is unprovable, and names Stop as the way out", async () => {
    const { runningRunId } = await seed();
    await db.update(heartbeatRuns).set({ processPid: 2_000_000_000, processHostHash: "another-host-pid-space",
      updatedAt: new Date(Date.now() - 10 * 60_000) }).where(eq(heartbeatRuns.id, runningRunId));
    await heartbeatService(db).reapOrphanedRuns({ staleThresholdMs: 5 * 60_000 });
    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, error: heartbeatRuns.error })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runningRunId));
    expect(run).toMatchObject({ status: "running", errorCode: "process_detached" });
    expect(run.error).toMatch(/cannot prove child pid .* stopped .*stop the run/);
  });

  it("still clears the lock when the audit write fails after terminalization", async () => {
    const { companyId, agentId, runningRunId } = await seed();
    // The run recorded a pid that never maps to a live process, so the sweep
    // decides to terminalize it. The issue is not terminal, so the
    // process-death authority drives the terminalization here.
    await db
      .update(heartbeatRuns)
      .set({ processPid: 2_000_000_000, runtimeMode: "native" })
      .where(eq(heartbeatRuns.id, runningRunId));
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Audit write fails — still clear the lock",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: runningRunId,
      executionRunId: runningRunId,
      executionLockedAt: new Date(),
    });

    // Make only the audit-event insert fail. The run update commits the
    // terminal status first, so the audit write is best-effort. The sweep must
    // catch the failure and still clear the lock.
    await db.execute(sql`
      create function reject_stale_lock_audit() returns trigger language plpgsql as $$
      begin raise exception 'simulated audit write failure'; end;
      $$
    `);

    try {
      await db.execute(sql`
        create trigger reject_stale_lock_audit before insert on heartbeat_run_events
        for each row execute function reject_stale_lock_audit()
      `);
      const heartbeat = heartbeatService(db);
      const result = await heartbeat.sweepStaleIssueLocks();

      expect(result.terminalizedRunIds).toEqual([runningRunId]);
      expect(result.cleared).toBe(1);
    } finally {
      await db.execute(sql`drop trigger if exists reject_stale_lock_audit on heartbeat_run_events`);
      await db.execute(sql`drop function reject_stale_lock_audit()`);
    }

    // The run reached its terminal status even though the audit write failed.
    const runStatus = await db
      .select({ status: heartbeatRuns.status, nextEventSeq: heartbeatRuns.nextEventSeq })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runningRunId))
      .then((rows) => rows[0]);
    expect(runStatus).toEqual({ status: "interrupted", nextEventSeq: 1 });

    // The sweep cleared the lock in the same pass.
    const lock = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
    expect(lock).toEqual({ checkoutRunId: null, executionRunId: null });

    // The audit write failed, so no run event exists for this run.
    const events = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runningRunId));
    expect(events).toEqual([]);
  });

  // The incident leaves durable state after executeRun's
  // NativeWorkspaceFinalizationBusyError early return (heartbeat.ts): R is
  // terminal, its issue still holds R, and no release drain has run. These are
  // real queue/sweep rows; dispatch is deliberately held at the task-drain
  // boundary so the promoted run can be inspected without a model/provider.
  describe("terminal native owner whose finalization skipped the release drain", () => {
    const userId = `sweep-drain-${randomUUID()}`;

    beforeAll(async () => {
      await db.insert(authUsers).values({ id: userId, name: "Chat owner", email: `${userId}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
    });
    afterEach(() => stopTaskDrain());
    afterAll(async () => { await db.delete(authUsers).where(eq(authUsers.id, userId)); });

    async function seedDeferredMessage(options: { paused?: boolean; done?: boolean } = {}) {
      const { companyId, agentId, runningRunId: runId } = await seed();
      const issueId = randomUUID();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
        status: "active", membershipRole: "operator" });
      await db.insert(issues).values({ id: issueId, companyId, title: options.done ? "Completed task" : "Conversation",
        status: options.done ? "in_progress" : "in_review", assigneeAgentId: agentId, responsibleUserId: userId,
        ...(!options.done ? { conversationAgentId: agentId, conversationUserId: userId, conversationState: "active" } : {}),
        checkoutRunId: runId, executionRunId: runId, executionLockedAt: new Date() });
      await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issueId,
        startedAt: new Date(Date.now() - 1_000), contextSnapshot: { issueId, taskKey: issueId } })
        .where(eq(heartbeatRuns.id, runId));
      const heartbeat = heartbeatService(db);
      let commentId: string | null = null;
      if (options.done) {
        // A plain, non-message automation wake, as in the stalled-blocker case.
        await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
          status: "deferred_issue_execution", reason: "issue_blocker_stalled", requestedByActorType: "system",
          payload: { issueId, _paperclipWakeContext: { issueId, wakeReason: "issue_blocker_stalled" } } });
      } else {
        const comment = await issueService(db).addComment(issueId, "Please answer this new message", { userId },
          { clientRequestId: randomUUID() });
        commentId = comment.id;
        const [conversation] = await db.select().from(issues).where(eq(issues.id, issueId));
        await deliverConversationComments(db, conversation!, heartbeat.wakeup);
      }
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(wake.payload).not.toHaveProperty("executionWait");
      if (commentId) expect(wake.idempotencyKey).toBe(`conversation-comment:${commentId}`);
      // Persist exactly the early-return aftermath: terminal R, with no call to
      // releaseIssueExecutionAndPromote. Do not simulate the fix in the fixture.
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      if (!options.done) await settleConversationTurn(db, finished!);
      if (options.done) await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      if (options.paused) await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
      startTaskDrain({});
      return { companyId, agentId, issueId, runId, wakeId: wake.id, commentId, heartbeat };
    }

    async function snapshot(f: Awaited<ReturnType<typeof seedDeferredMessage>>) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wakeId));
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, f.wakeId));
      return { issue: issue!, wake: wake!, runs };
    }

    it("dr-1 promotes the person's plain conversation wake once after the stale-lock sweep", async () => {
      const f = await seedDeferredMessage();
      const before = await snapshot(f);
      expect(before.issue.executionRunId).toBe(f.runId);
      expect(before.runs).toEqual([]);
      const started = Date.now();
      await f.heartbeat.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
      const after = await snapshot(f);
      console.info("dr-1 persisted result", JSON.stringify({ runId: f.runId, wakeId: f.wakeId, commentId: f.commentId,
        elapsedMs: Date.now() - started, oldLockReleased: after.issue.executionRunId !== f.runId,
        checkoutRunId: after.issue.checkoutRunId, executionRunId: after.issue.executionRunId,
        wakeStatus: after.wake.status, promotedRuns: after.runs.map(run => ({ id: run.id, status: run.status, context: run.contextSnapshot })) }));
      expect(after.issue.checkoutRunId).toBeNull();
      expect(after.issue.executionRunId).not.toBe(f.runId);
      expect(after.wake.status).toBe("queued");
      expect(after.runs).toHaveLength(1);
      expect(after.runs[0]).toMatchObject({ status: "queued", wakeupRequestId: f.wakeId,
        contextSnapshot: { issueId: f.issueId, wakeCommentId: f.commentId, wakeCommentIds: [f.commentId] } });
      expect(after.wake.runId).toBe(after.runs[0]!.id);
      expect(after.issue.executionRunId).toBe(after.runs[0]!.id);
      // Repeated sweeps must not duplicate the queued turn or steal its lock.
      await f.heartbeat.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
      const repeated = await snapshot(f);
      expect(repeated.runs.map(run => run.id)).toEqual(after.runs.map(run => run.id));
      expect(repeated.issue.executionRunId).toBe(after.runs[0]!.id);
    });

    it("dr-2 preserves the drain's paused-agent gate while releasing the old lock", async () => {
      const f = await seedDeferredMessage({ paused: true });
      await f.heartbeat.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
      const after = await snapshot(f);
      console.info("dr-2 persisted result", JSON.stringify({ wakeStatus: after.wake.status, runs: after.runs.length,
        checkoutRunId: after.issue.checkoutRunId, executionRunId: after.issue.executionRunId }));
      expect(after.runs).toEqual([]);
      expect(after.wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(after.issue).toMatchObject({ checkoutRunId: null, executionRunId: null });
    });

    it("dr-3 never runs or reopens a DONE task for a plain stalled-blocker wake", async () => {
      const f = await seedDeferredMessage({ done: true });
      await f.heartbeat.sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
      const after = await snapshot(f);
      console.info("dr-3 persisted result", JSON.stringify({ status: after.issue.status, wakeStatus: after.wake.status,
        runs: after.runs.length, checkoutRunId: after.issue.checkoutRunId, executionRunId: after.issue.executionRunId }));
      expect(after.runs).toEqual([]);
      expect(after.wake.runId).toBeNull();
      expect(after.issue).toMatchObject({ status: "done", checkoutRunId: null, executionRunId: null });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.updated")))).toEqual([]);
    });

    it("dr-4 logs a throwing drain and still performs the original guarded lock clear", async () => {
      const f = await seedDeferredMessage();
      // The only fault injection is at the release-drain boundary. Its failure
      // must not prevent the existing sweep's real SQL clear or audit write.
      const deps = { enqueueWakeup: vi.fn(), releaseTerminalExecutionOwner: async () => {
        throw new Error("dr-4 injected release-drain failure");
      } };
      const result = await recoveryService(db, deps).sweepStaleIssueLocks({ companyId: f.companyId, issueId: f.issueId });
      const after = await snapshot(f);
      console.info("dr-4 persisted result", JSON.stringify({ cleared: result.cleared, wakeStatus: after.wake.status,
        runs: after.runs.length, checkoutRunId: after.issue.checkoutRunId, executionRunId: after.issue.executionRunId }));
      expect(result.issueIds).toEqual([f.issueId]);
      expect(after.issue).toMatchObject({ checkoutRunId: null, executionRunId: null });
      expect(after.runs).toEqual([]);
      expect(after.wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.issueId),
        eq(activityLog.action, "issue.stale_lock_cleared")))).toHaveLength(1);
    });
  });

  // Combined acceptance: real guarded sweep -> release drain -> persisted queue,
  // and the boot stranded sweep -> conversation outbox. Only provider execution
  // is simulated, after inspecting the actual admitted run and its input ids.
  describe("IB paired drain, stale-wake and boot outbox", () => {
    const owner = `ib-owner-${randomUUID()}`;
    const ago = (ms: number) => new Date(Date.now() - ms);
    const hour = 60 * 60_000;
    const day = 24 * hour;

    beforeAll(async () => {
      await db.insert(authUsers).values({ id: owner, name: "Chat owner", email: `${owner}@example.test`,
        createdAt: new Date(), updatedAt: new Date() });
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    });
    afterEach(() => stopTaskDrain());
    afterAll(async () => { await db.delete(authUsers).where(eq(authUsers.id, owner)); });

    async function chat() {
      const [company] = await db.insert(companies).values({ name: "Daily work", issuePrefix: "SMA",
        requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: owner }).returning();
      const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Daily agent", role: "engineer",
        status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).returning();
      await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: owner,
        status: "active", membershipRole: "operator" });
      const [issue] = await db.insert(issues).values({ companyId: company.id, identifier: "SMA-4", title: "Daily chat",
        status: "in_review", assigneeAgentId: agent.id, responsibleUserId: owner,
        conversationAgentId: agent.id, conversationUserId: owner, conversationState: "waiting" }).returning();
      startTaskDrain({}); // No provider dispatch; admission, custody and sweeps remain real.
      return { companyId: company.id, agentId: agent.id, issueId: issue.id,
        heartbeat: await wiredHeartbeatFor(db, "test:deferred-person-bound:chat") };
    }
    type Chat = Awaited<ReturnType<typeof chat>>;
    async function message(c: Chat, body: string, at: Date) {
      const m = await issueService(db).addComment(c.issueId, body, { userId: owner }, { clientRequestId: randomUUID() });
      await db.update(issueComments).set({ createdAt: at, updatedAt: at }).where(eq(issueComments.id, m.id));
      return { ...m, createdAt: at };
    }
    async function run(c: Chat, ids: string[], at: Date, status = "succeeded", finishedAt = new Date(at.getTime() + 30_000)) {
      const [r] = await db.insert(heartbeatRuns).values({ companyId: c.companyId, agentId: c.agentId,
        status, invocationSource: "on_demand", runtimeMode: "native", nativeIssueId: c.issueId,
        createdAt: at, startedAt: at, finishedAt,
        contextSnapshot: { issueId: c.issueId, taskKey: c.issueId, wakeCommentIds: ids } }).returning();
      return r;
    }
    async function reply(c: Chat, r: typeof heartbeatRuns.$inferSelect, body: string) {
      await db.insert(issueComments).values({ companyId: c.companyId, issueId: c.issueId, authorType: "agent",
        authorAgentId: c.agentId, createdByRunId: r.id, body, createdAt: r.finishedAt ?? new Date() });
    }
    async function deferred(c: Chat, id: string, at: Date) {
      const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: owner, requestedAt: at,
        idempotencyKey: `conversation-comment:${id}`, payload: withQueuedCommentIdsInWakePayload({ issueId: c.issueId,
          _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "issue_commented" } }, [id]) }).returning();
      return w;
    }
    async function issue(c: Chat) {
      return (await db.select().from(issues).where(eq(issues.id, c.issueId)))[0]!;
    }
    async function queuedRuns(wakeId: string) {
      return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, wakeId));
    }
    async function wake(wakeId: string) {
      return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]!;
    }
    async function systemNotes(c: Chat) {
      return db.select().from(issueComments).where(and(eq(issueComments.companyId, c.companyId),
        eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "system")));
    }
    async function unansweredSweep(c: Chat) {
      await settleUnansweredPersonMessage(db, { companyId: c.companyId, issueId: c.issueId,
        now: new Date(), olderOutcomes: [] });
    }
    async function boot(c: Chat, enqueue = c.heartbeat.wakeup) {
      // This is the production boot stranded sweep, not a direct outbox-query assertion.
      return recoveryService(db, { enqueueWakeup: enqueue }).reconcileStrandedAssignedIssues({
        companyId: c.companyId, issueId: c.issueId });
    }
    async function busyFinalization(c: Chat, r: typeof heartbeatRuns.$inferSelect) {
      await db.update(issues).set({ executionRunId: r.id, checkoutRunId: r.id,
        executionLockedAt: ago(6 * 60_000) }).where(eq(issues.id, c.issueId));
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: r.id, phase: "applied", updatedAt: ago(6 * 60_000) });
      const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => owner,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }), recovery: {
        escalateStrandedAssignedIssue: async () => { throw new Error("unexpected recovery"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected recovery"); },
      } });
      // Exercise the actual early return: it neither drains nor releases the lock.
      expect((await release({ companyId: c.companyId, runId: r.id, now: new Date(),
        resumeStrandedQueue: true })).outcome.kind).toBe("released");
      expect((await issue(c)).executionRunId).toBe(r.id);
      await db.update(nativeRunFinalizations).set({ phase: "committed" })
        .where(eq(nativeRunFinalizations.runId, r.id));
    }

    async function settleSavedOwner(c: Awaited<ReturnType<typeof chat>>) {
      const ownerId = (await issue(c)).executionRunId;
      if (ownerId) await settleOwnableKind(db, "issue_execution_lock", { runIds: [ownerId] });
    }

    async function boundFixture(gapMs = 500) {
      const c = await chat();
      const last = ago(13_000);
      const messages = await Promise.all(["first", "last", "very last"].map((text, i) =>
        message(c, `BOUND ${text}`, new Date(last.getTime() - (2 - i) * 100))));
      const w = await deferred(c, messages[0].id, new Date(last.getTime() - 200));
      // Actual queue coalesces, each committed separately. Only persisted times
      // are moved backwards to exercise the 12-second bound without a clock mock.
      for (let i = 1; i < messages.length; i++) await db.transaction(async tx => {
        await createWakeAdmissionWriter().mergeIntoExistingDeferredWake(
          createAdmissionTransactionScope(c.companyId, tx as unknown as typeof db), {
            companyId: c.companyId, existingDeferredWakeId: w.id, manualUserWakeActorId: owner,
            mergedPayload: withQueuedCommentIdsInWakePayload(w.payload, messages.slice(0, i + 1).map(m => m.id)),
            nextCoalescedCount: i + 1,
          });
      });
      await db.update(agentWakeupRequests).set({ updatedAt: last,
        payload: { ...(await wake(w.id)).payload, _paperclipLastCoalescedAt: last.toISOString() },
      }).where(eq(agentWakeupRequests.id, w.id));
      const r = await run(c, [], ago(30_000), "succeeded", new Date(last.getTime() + gapMs));
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: r.id, phase: "committed" });
      return { c, w, r, messages };
    }
    function boundRelease() {
      return createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => owner,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }), recovery: { escalateStrandedAssignedIssue: async () => {},
        escalateStrandedRecoveryIssueInPlace: async () => {} } });
    }
    it.each([500, 8, 5_000, 9_600])("BOUND: last coalesce %i ms before normal end drains every message once", async gap => {
      const { c, w, r, messages } = await boundFixture(gap);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      const runs = await queuedRuns(w.id);
      expect(runs).toHaveLength(1);
      expect(new Set(runs[0].contextSnapshot?.wakeCommentIds)).toEqual(new Set(messages.map(m => m.id)));
      await Promise.all([c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId }),
        boundRelease()({ companyId: c.companyId, runId: r.id, now: new Date(), suppressImmediateRecovery: true })]);
      expect(await queuedRuns(w.id)).toHaveLength(1);
      process.stdout.write(`BOUND evidence ${JSON.stringify({ gap, wakeId: w.id, sourceRunId: r.id,
        promotedRunId: runs[0].id, commentIds: runs[0].contextSnapshot?.wakeCommentIds })}\n`);
    });
    it.each([true, false])("BOUNDCLOCK: three real stranded-receipt passes cannot reset the quiet clock (coalesced=%s)", async coalesced => {
      const { c, w } = await boundFixture();
      if (!coalesced) {
        const { _paperclipLastCoalescedAt: _clock, ...payload } = (await wake(w.id)).payload!;
        await db.update(agentWakeupRequests).set({ payload, coalescedCount: 0 })
          .where(eq(agentWakeupRequests.id, w.id));
      }
      // A real eligibility gate explains why the stranded pass's own ordinary
      // release does not admit the wake. Its scan still touches updated_at.
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, c.agentId));
      const queue = createHeartbeatQueue(db, {
        getSchedulingSuppression: async () => ({ suppressed: false, reason: null }),
        getWorktreeExecutionCutoff: async () => null,
        resumeExecutionWaitComments: async () => {}, // no executionWait in this row
        isHeartbeatRunTerminalStatus: status => ["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(status ?? ""),
        releaseIssueExecutionAndPromote: c.heartbeat.releaseIssueExecutionAndPromote,
      } as unknown as HeartbeatQueueDependencies);
      const errors: unknown[] = [];
      const touches: string[] = [];
      {
        // Reconstruct the actual worker three times, as boot/reconstruction does.
        for (let pass = 0; pass < 3; pass++) {
          const before = await wake(w.id);
          const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
          const worker = registerDeferredReceiptWork(db, coordinator, {
            resume: scope => queue.resumeDeferredExecutionReceipts(scope),
            settleTaskChat: async () => {}, createNativeBatch: () => async () => {},
            schedulingSuppressed: async () => false,
          }, () => true);
          try {
            await worker.ready;
            await vi.waitFor(async () => expect((await wake(w.id)).updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime()));
          } finally { await worker.stop(); await coordinator.stop(); }
          touches.push((await wake(w.id)).updatedAt.toISOString());
          expect(await queuedRuns(w.id)).toHaveLength(0);
        }
        await db.update(agents).set({ status: "idle" }).where(eq(agents.id, c.agentId));
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        const promoted = await queuedRuns(w.id);
        process.stdout.write(`BOUNDCLOCK evidence ${JSON.stringify({ coalesced, wakeId: w.id, touches,
          requestedAt: w.requestedAt, saved: await wake(w.id), promoted: promoted.map(r => r.id), errors })}\n`);
        expect(errors).toEqual([]);
        expect(promoted).toHaveLength(1);
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        expect(await queuedRuns(w.id)).toHaveLength(1);
      }
    });
    it("BOUNDCLOCK: a succeeded run still holding the issue resumes only after ingestion settles", async () => {
      const { c, w, r, messages } = await boundFixture();
      await db.update(issues).set({ executionRunId: r.id, checkoutRunId: r.id,
        executionLockedAt: new Date() }).where(eq(issues.id, c.issueId));
      await db.update(heartbeatRuns).set({ contextSnapshot: { ...r.contextSnapshot, steeredCommentIds: [messages[0].id] },
        resultJson: { steeringIngestionReleaseHeld: true, nativeSteeringIngestion: { state: "open" } },
      }).where(eq(heartbeatRuns.id, r.id));
      await boundRelease()({ companyId: c.companyId, runId: r.id, now: new Date(),
        suppressImmediateRecovery: true, resumeStrandedQueue: true });
      expect(await queuedRuns(w.id)).toHaveLength(0);
      expect((await issue(c)).executionRunId).toBe(r.id);
      // Crash boundary: ingestion committed its proof, but its release callback
      // did not run. The sweep must retry the SAME guarded release owner.
      await db.update(heartbeatRuns).set({ resultJson: { steeringIngestionReleaseHeld: true,
        nativeSteeringIngestion: { state: "terminal_ingested" } } }).where(eq(heartbeatRuns.id, r.id));
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await queuedRuns(w.id)).toHaveLength(1);
      expect((await issue(c)).executionRunId).not.toBe(r.id);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await queuedRuns(w.id)).toHaveLength(1);
    });
    it("BOUNDCLOCK: requested_at remains the lower bound when it is newer than the marker", async () => {
      const { c, w } = await boundFixture();
      const requestedAt = new Date();
      await db.update(agentWakeupRequests).set({ requestedAt }).where(eq(agentWakeupRequests.id, w.id));
      const hints: number[] = [];
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId,
        onDeferredDeadline: at => hints.push(at) });
      expect(await queuedRuns(w.id)).toHaveLength(0);
      expect(hints).toContain(requestedAt.getTime() + 12_000);
    });
    it("BOUNDCLOCK: a live skip re-arms the real deadline worker until the run finishes", async () => {
      const { c, w, r } = await boundFixture();
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, r.id));
      const hints: number[] = [];
      const started = Date.now();
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId,
        onDeferredDeadline: at => hints.push(at) });
      expect(await queuedRuns(w.id)).toHaveLength(0);
      expect(hints.some(at => at >= started + 12_000 && at <= Date.now() + 12_000)).toBe(true);
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
      const worker = registerIssueRecoveryWork(db, coordinator, {
        schedulingSuppressed: async () => false, locks: c.heartbeat.sweepStaleIssueLocks,
        stranded: async () => {}, orphanBlockers: async () => {}, recoveryActions: async () => {},
        dependencies: async () => ({ enqueueFailed: 0 }), watchdogs: async () => ({ incomplete: 0 }),
      }, () => true);
      try {
        await worker.ready;
        // Let its initial real sweep see the live owner, then finish without
        // emitting a run-end signal. Only the armed clock can wake it again.
        await new Promise(resolve => setTimeout(resolve, 400));
        const endedAt = Date.now();
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, r.id));
        await vi.waitFor(async () => expect(await queuedRuns(w.id)).toHaveLength(1), { timeout: 14_000, interval: 50 });
        expect(Date.now() - endedAt).toBeLessThan(13_000);
        expect(errors).toEqual([]);
        process.stdout.write(`BOUNDCLOCK live evidence ${JSON.stringify({ wakeId: w.id, hints,
          terminalToPromotionMs: Date.now() - endedAt, runIds: (await queuedRuns(w.id)).map(r => r.id) })}\n`);
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        expect(await queuedRuns(w.id)).toHaveLength(1);
      } finally { await worker.stop(); await coordinator.stop(); }
    }, 20_000);
    it("BOUND: simultaneous person's Send, sweep and end release admit one carrier", async () => {
      const { c, w, r, messages } = await boundFixture();
      // Send records its intent under the issue lock, then invokes this real
      // continuation owner, exactly as queued-comments/interrupt does.
      const send = async () => {
        await db.transaction(async tx => {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, c.issueId)).for("update");
          const [saved] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, w.id));
          if (saved.status === "deferred_issue_execution") await tx.update(agentWakeupRequests).set({
            payload: { ...saved.payload, queuedCommentInterrupt: { actorId: owner, requestedAt: new Date().toISOString() } },
            updatedAt: new Date(),
          }).where(eq(agentWakeupRequests.id, w.id));
        });
        await c.heartbeat.resumeQueuedCommentInterrupt(c.companyId, w.id, { retryCleanup: true });
      };
      await Promise.all([
        c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId }),
        boundRelease()({ companyId: c.companyId, runId: r.id, now: new Date(), suppressImmediateRecovery: true }),
        send(),
      ]);
      const admitted = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId)))
        .filter(x => x.id !== r.id);
      expect(admitted).toHaveLength(1);
      const context = admitted[0].contextSnapshot!;
      expect(new Set([...(context.wakeCommentIds as string[] ?? []), context.wakeCommentId].filter(Boolean)))
        .toEqual(new Set(messages.map(m => m.id)));
      process.stdout.write(`BOUND race evidence ${JSON.stringify({ wakeId: w.id, runId: admitted[0].id, context })}\n`);
    });
    it.each(["paused", "running", "finalizing", "system", "agent"])("BOUND: %s stays held", async hold => {
      const { c, w, r } = await boundFixture();
      if (hold === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, c.agentId));
      if (hold === "running") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
        .where(eq(heartbeatRuns.id, r.id));
      if (hold === "finalizing") await db.update(nativeRunFinalizations).set({ phase: "applied" })
        .where(eq(nativeRunFinalizations.runId, r.id));
      if (hold === "system" || hold === "agent") await db.update(agentWakeupRequests)
        .set({ source: "automation", requestedByActorType: hold, reason: "issue_commented" })
        .where(eq(agentWakeupRequests.id, w.id));
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await wake(w.id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await queuedRuns(w.id)).toHaveLength(0);
    });
    it("BOUND: real periodic worker discovers an unlocked wake and honors its deadline", async () => {
      const { c, w } = await boundFixture();
      const last = ago(11_000);
      await db.update(agentWakeupRequests).set({ updatedAt: last,
        payload: { ...(await wake(w.id)).payload, _paperclipLastCoalescedAt: last.toISOString() },
      }).where(eq(agentWakeupRequests.id, w.id));
      const errors: unknown[] = [];
      const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
        onError: err => errors.push(err) });
      const worker = registerIssueRecoveryWork(db, coordinator, {
        schedulingSuppressed: async () => false, locks: c.heartbeat.sweepStaleIssueLocks,
        stranded: async () => {}, orphanBlockers: async () => {}, recoveryActions: async () => {},
        dependencies: async () => ({ enqueueFailed: 0 }), watchdogs: async () => ({ incomplete: 0 }),
      }, () => true);
      const started = Date.now();
      try {
        await worker.ready;
        while (!(await queuedRuns(w.id)).length && Date.now() - started < 4_000)
          await new Promise(resolve => setTimeout(resolve, 50));
        const runs = await queuedRuns(w.id);
        expect(errors).toEqual([]);
        expect(runs).toHaveLength(1);
        expect(Date.now() - last.getTime()).toBeLessThan(15_000);
        process.stdout.write(`BOUND worker evidence ${JSON.stringify({ wakeId: w.id, runId: runs[0].id,
          lastCoalesce: last.toISOString(), elapsedMs: Date.now() - started })}\n`);
      } finally { await worker.stop(); await coordinator.stop(); }
    });
    it("BOUND: held automation heads stay byte-for-byte unchanged beside a due person wake", async () => {
      const { c, w } = await boundFixture();
      const [heldSystem, heldAgent] = await db.insert(agentWakeupRequests).values(["system", "agent"].map(actor => ({
        companyId: c.companyId, agentId: c.agentId, source: "automation", requestedByActorType: actor,
        reason: "issue_commented", status: "deferred_issue_execution", requestedAt: ago(day),
        payload: { issueId: c.issueId, guard: actor }, updatedAt: ago(day),
      }))).returning();
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await queuedRuns(w.id)).toHaveLength(1);
      expect(await wake(heldSystem.id)).toEqual(heldSystem);
      expect(await wake(heldAgent.id)).toEqual(heldAgent);
    });
    it("BOUND: boot's >24h person message keeps its one-note/no-run rule", async () => {
      const c = await chat();
      const old = ago(2 * day);
      const m = await message(c, "BOUND old saved question", old);
      const w = await deferred(c, m.id, old);
      await db.update(agentWakeupRequests).set({ createdAt: old, updatedAt: old }).where(eq(agentWakeupRequests.id, w.id));
      const r = await run(c, [], ago(hour));
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: r.id, phase: "committed" });
      // The persisted old boot already observed the pending receipt. Age
      // that real observation too, so the existing two-minute notice grace
      // is expired rather than changing the notice/owed definitions here.
      await boot(c); await unansweredSweep(c);
      await db.update(activityLog).set({ createdAt: ago(3 * 60_000) }).where(and(
        eq(activityLog.companyId, c.companyId), eq(activityLog.action, "issue.unanswered_message_wait")));
      await unansweredSweep(c);
      const notes = await systemNotes(c);
      expect(notes).toHaveLength(1);
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await boot(c); await unansweredSweep(c);
      }
      expect(await queuedRuns(w.id)).toHaveLength(0);
      expect(await systemNotes(c)).toEqual(notes);
    });
    it("BOUND: last coalesce, not creation, owns the deadline hint", async () => {
      const { c, w } = await boundFixture();
      await db.transaction(async tx => {
        await createWakeAdmissionWriter().mergeIntoExistingDeferredWake(
          createAdmissionTransactionScope(c.companyId, tx as unknown as typeof db), {
            companyId: c.companyId, existingDeferredWakeId: w.id, manualUserWakeActorId: owner,
            mergedPayload: (await wake(w.id)).payload!, nextCoalescedCount: 3,
          });
      });
      const saved = await wake(w.id);
      const latest = saved.updatedAt;
      const hints: number[] = [];
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId,
        onDeferredDeadline: at => hints.push(at) });
      expect(await queuedRuns(w.id)).toHaveLength(0);
      expect(hints).toContain(latest.getTime() + 12_000);
    });

    it.each(["observed", "applied"] as const)("SYNCOUT: persisted %s result fails copyback across restart, ends and carries later person input", async phase => {
      const c = await chat();
      const m = await message(c, "Please carry my next question after copyback fails", new Date());
      const w = await deferred(c, m.id, new Date());
      const r = await run(c, [], ago(hour), "running");
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId: c.companyId, issueId: c.issueId,
        revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "syncout-row",
        risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { objective: "Save completed work" }, canonicalSha256: contractId,
        createdByActorType: "system", createdByActorId: "syncout-row" });
      await db.update(heartbeatRuns).set({ finishedAt: null, completionContractId: contractId,
        resultJson: { prpRunTerminalState: "succeeded" } }).where(eq(heartbeatRuns.id, r.id));
      await db.insert(nativeRunResults).values({ id: resultId, companyId: c.companyId, issueId: c.issueId,
        runId: r.id, completionContractId: contractId, serverFingerprint: resultId,
        schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: r.id, resultId, phase, attempt: 1 });
      await db.update(issues).set({ executionRunId: r.id, checkoutRunId: r.id })
        .where(eq(issues.id, c.issueId));
      // Actual production failure recorder, not a hand-authored watchdog action.
      await recordNativeWorkspaceFinalizationFailure(db, r.id, { stderrExcerpt: "workspace_sync_out_failed" });
      const settledLocks = await settleOwnableKind(db, "issue_execution_lock", { runIds: [r.id] });
      expect(settledLocks).toEqual([]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id)))[0].status).toBe("running");
      console.info("SYNCOUT registry running owner", JSON.stringify({ settledLocks,
        finalization: (await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, r.id)))[0] }));
      // A reconstructed worker discovers the persisted retry independently of
      // any pre-boot system wake. Only the external export operation is injected.
      const attempt = vi.fn(async () => ({ kind: "failed" as const,
        operation: { stderrExcerpt: "plugin_workspace_inspection_failed" as const } }));
      for (let retry = 0; retry < 2; retry++) {
        await db.update(nativeRunFinalizations).set({ nextAttemptAt: new Date(Date.now() - 1) })
          .where(eq(nativeRunFinalizations.runId, r.id));
        const worker = nativeWorkspaceFinalizationWork(db, { attempt,
          onWorkspaceSettled: async () => {} });
        const entries = await worker.load({ companyId: c.companyId, runId: r.id });
        expect(entries).toHaveLength(1);
        await worker.check(entries[0]);
      }
      // Terminal failure itself must hand off custody: no explicit sweep or
      // caller release may be required for the message to acquire a run.
      expect(await queuedRuns(w.id)).toHaveLength(1);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id));
      expect(ended).toMatchObject({ status: "failed", finishedAt: expect.any(Date),
        errorCode: "native_workspace_sync_out_retry_exhausted" });
      console.info("SYNCOUT card after deferred promotion", JSON.stringify(await taskInterruptionPresentation(db, await issue(c))));
      expect((await issue(c)).executionRunId).not.toBe(r.id);
      // Real release admission, without a model invocation: prove custody of
      // the exact deferred person id in one successor run.
      await c.heartbeat.releaseIssueExecutionAndPromote(ended);
      const successors = await queuedRuns(w.id);
      console.info("SYNCOUT persisted proof", JSON.stringify({ phase, ended: ended.status,
        lock: (await issue(c)).executionRunId, wake: await wake(w.id), successors }));
      expect(successors).toHaveLength(1);
      expect(successors[0].contextSnapshot?.wakeCommentIds).toContain(m.id);
    });

    async function abandonedCopyback(age: number, hasMessage = false) {
      const c = await chat();
      const m = hasMessage ? await message(c, "Please answer after saving files", ago(age)) : null;
      const w = m ? await deferred(c, m.id, ago(age)) : null;
      const r = await run(c, [], ago(age + hour), "running");
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId: c.companyId, issueId: c.issueId,
        revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "bound-row",
        risk: "standard", completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: { objective: "Save completed work" }, canonicalSha256: contractId,
        createdByActorType: "system", createdByActorId: "bound-row" });
      await db.update(heartbeatRuns).set({ finishedAt: null, nativePhase: "retryable_failure", errorCode: null,
        completionContractId: contractId, resultJson: { prpRunTerminalState: "succeeded",
          ...pendingNativeWithheldReply(resultId, null, "acceptance") } }).where(eq(heartbeatRuns.id, r.id));
      await db.insert(nativeRunResults).values({ id: resultId, companyId: c.companyId, issueId: c.issueId,
        runId: r.id, completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted",
        resultJson: { summary: "OLD_SAVED_REPLY_MUST_NOT_BE_RESENT" }, canonicalSha256: resultId });
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: r.id, resultId, phase: "retryable_failure", attempt: 1, nextAttemptAt: ago(age) });
      await db.insert(workspaceOperations).values({ companyId: c.companyId, issueId: c.issueId,
        heartbeatRunId: r.id, phase: "workspace_finalize", status: "failed" });
      await db.update(issues).set({ status: "in_progress", executionRunId: r.id, checkoutRunId: r.id })
        .where(eq(issues.id, c.issueId));
      return { c, r, m, w };
    }
    it("SYNCOUT no deferred message: terminal retry drain creates no extra run", async () => {
      const { c, r } = await abandonedCopyback(1);
      for (let attempt = 0; attempt < 4; attempt++) {
        await recordNativeWorkspaceFinalizationFailure(db, r.id, { stderrExcerpt: "workspace_sync_out_failed" });
      }
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id)))[0])
        .toMatchObject({ status: "failed", finishedAt: expect.any(Date), nativePhase: "terminal_failure" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId))).toHaveLength(1);
      expect((await issue(c)).executionRunId).toBeNull();
      expect(await taskInterruptionPresentation(db, await issue(c))).toMatchObject({ state: "failed", canRetry: true });
    });
    it.each(["boot", "periodic"])("BOUND: d6e5a901 durable shape ends at %s with one true card and Retry, no extra run", async trigger => {
      const { c, r } = await abandonedCopyback(11 * 60_000);
      // The same boot and periodic production entry points, not a fake watchdog.
      if (trigger === "boot") await c.heartbeat.recoverNativeRunsAfterRestart(new Date(), [r.id], { skipDelegatedWork: true });
      else await c.heartbeat.reapOrphanedRuns({ skipNativeWorkspaceFinalization: true, skipNativeResultCommit: true });
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id));
      const card = await taskInterruptionPresentation(db, await issue(c));
      console.info("BOUND persisted proof", JSON.stringify({ trigger, ended, card }));
      expect(ended).toMatchObject({ status: "failed", nativePhase: "terminal_failure", finishedAt: expect.any(Date),
        errorCode: "native_workspace_sync_out_retry_exhausted" });
      expect(card).toMatchObject({ state: "failed", canRetry: true });
      expect((await issue(c)).executionRunId).toBeNull();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId))).toHaveLength(1);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, c.issueId))).toHaveLength(1);
    });
    it("BOUND days-old: boot ends the run once, with one card, no replay, no old message woken", async () => {
      const { c, r, w } = await abandonedCopyback(3 * 24 * hour, true);
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.recoverNativeRunsAfterRestart(new Date(), [r.id], { skipDelegatedWork: true });
        await reconcileNativeFinalizations(db, [r.id]);
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      }
      const [ended] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, r.id));
      const card = await taskInterruptionPresentation(db, await issue(c));
      console.info("BOUND days-old proof", JSON.stringify({ ended, card, wake: await wake(w!.id) }));
      expect(ended).toMatchObject({ status: "failed", finishedAt: expect.any(Date), nativePhase: "terminal_failure" });
      expect(card).toMatchObject({ state: "failed", canRetry: true });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId))).toHaveLength(1);
      expect(await queuedRuns(w!.id)).toEqual([]);
      expect(ended.resultJson?.nativeWithheldReply).toMatchObject({ state: "skipped", reason: "historical_workspace_retry_timeout" });
      expect(await nativeResponsePresentationWork(db).load({ companyId: c.companyId, runId: r.id })).toEqual([]);
      expect(await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId), eq(issueComments.authorType, "agent")))).toEqual([]);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, c.issueId))).toHaveLength(1);
      expect((await issue(c)).executionRunId).toBeNull();
    });

    it.each(["automation_no_new_person", "deferred_restore_recovery", "issue_blocker_stalled", "issue_monitor"])(
      "boot-4b/406/4c: pre-boot %s retains its base promotion or hold across two sweeps", async reason => {
        const c = await chat();
        if (reason === "issue_blocker_stalled") await db.update(issues).set({ status: "done",
          conversationAgentId: null, conversationUserId: null, conversationState: null }).where(eq(issues.id, c.issueId));
        const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
          source: "automation", triggerDetail: "system", reason, requestedByActorType: "system",
          status: "deferred_issue_execution", requestedAt: ago(4 * hour), payload: { issueId: c.issueId,
            _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: reason } } }).returning();
        const ownerRun = await run(c, [], ago(hour));
        await busyFinalization(c, ownerRun);
        for (let pass = 0; pass < 2; pass++) await settleSavedOwner(c);
        const admitted = await queuedRuns(w.id);
        if (reason === "issue_monitor") {
          // A monitor is the durable check driver, not historical chat input.
          expect(admitted).toHaveLength(1);
          expect(await wake(w.id)).toMatchObject({ status: "queued", runId: admitted[0].id });
        } else {
          expect(admitted).toEqual([]);
          // Restore/export and other held kinds retain their existing custody.
          expect(await wake(w.id)).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: w.payload });
        }
        expect(await systemNotes(c)).toEqual([]);
        console.info("boot-4c retained", JSON.stringify({ reason, wakeId: w.id, runCount: admitted.length }));
      });

    it.each(["issue_monitor", "issue_monitor_due"])(
      "F1: sole pre-boot %s driver promotes once and the check can re-arm its next deadline", async reason => {
        const c = await chat();
        await db.update(issues).set({ status: "in_progress", conversationAgentId: null,
          conversationUserId: null, conversationState: null, monitorNextCheckAt: null })
          .where(eq(issues.id, c.issueId));
        const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
          source: "automation", triggerDetail: "system", reason, requestedByActorType: "system",
          status: "deferred_issue_execution", requestedAt: ago(4 * hour), payload: { issueId: c.issueId,
            _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: reason,
              source: "issue.monitor" } } }).returning();
        const ownerRun = await run(c, [], ago(hour));
        await busyFinalization(c, ownerRun);
        await boot(c);
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await settleSavedOwner(c);
        const admitted = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"])));
        console.info("F1 after boot", JSON.stringify({ reason, wake: await wake(w.id),
          runs: admitted.map(r => ({ id: r.id, wakeupRequestId: r.wakeupRequestId, status: r.status })),
          monitorNextCheckAt: (await issue(c)).monitorNextCheckAt }));
        expect(admitted).toHaveLength(1);
        expect(admitted[0].contextSnapshot).toMatchObject({ issueId: c.issueId, wakeReason: reason });
        // Promotion admits the overdue check; it does NOT invent its next deadline.
        expect((await issue(c)).monitorNextCheckAt).toBeNull();
        // Simulate only the provider's useful result through the real issue service.
        // The check explicitly schedules its next check, as it did before this fix.
        const nextCheckAt = new Date(Date.now() + hour);
        await issueService(db).update(c.issueId, { executionPolicy: {
          mode: "normal", commentRequired: true, stages: [],
          monitor: { nextCheckAt: nextCheckAt.toISOString(), notes: "Check the daily deployment again" },
        } });
        expect((await issue(c)).monitorNextCheckAt).toEqual(nextCheckAt);
        for (let pass = 0; pass < 2; pass++) {
          await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
          await settleSavedOwner(c);
        }
        const repeated = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
          inArray(heartbeatRuns.status, ["queued", "running"])));
        expect(repeated.map(r => r.id)).toEqual(admitted.map(r => r.id));
        expect((await issue(c)).monitorNextCheckAt).toEqual(nextCheckAt);
        console.info("F1 re-armed", JSON.stringify({ reason, runId: admitted[0].id,
          monitorNextCheckAt: (await issue(c)).monitorNextCheckAt, runCount: repeated.length }));
      });

    it("boot-4c: a pre-boot restore envelope with already-answered person input retains its system obligation", async () => {
      const c = await chat();
      const m = await message(c, "Already answered before this restart", ago(4 * hour));
      const r = await run(c, [m.id], ago(3 * hour));
      await reply(c, r, "Answered the saved person input");
      const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "automation", reason: "deferred_restore_recovery", requestedByActorType: "system",
        status: "deferred_issue_execution", requestedAt: ago(4 * hour), payload: { issueId: c.issueId,
          _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "deferred_restore_recovery",
            wakeCommentIds: [m.id] } } }).returning();
      await busyFinalization(c, r);
      await settleSavedOwner(c);
      expect(await queuedRuns(w.id)).toEqual([]);
      expect(await wake(w.id)).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: w.payload });
      expect(await systemNotes(c)).toEqual([]);
    });

    it.each([true, false].flatMap(hasHead => ["done", "done-single", "mixed", "blocked", "blocked-single", "other"].map(disposition => ({ hasHead, disposition }))))(
      "his-shape: $disposition one-id deferred head=$hasHead plus pending pre-boot deliveries never run", async ({ hasHead, disposition }) => {
      const c = await chat();
      const ids: string[] = [];
      // A delivery can outlive any later status change; those tasks remain unnamed.
      const otherStatuses = ["backlog", "todo", "in_progress", "monitoring", "in_review", "cancelled"];
      const identifiers = disposition === "other" ? otherStatuses.map((_, index) => `OTHER-${index}`)
        : disposition.endsWith("-single") ? ["SMA-611"] : ["SMA-611", "SMA-618", "SMA-617", "SMA-615", "SMA-616"];
      for (const [index, identifier] of identifiers.entries()) {
        const at = ago(13 * hour - index);
        const status = disposition === "other" ? otherStatuses[index]
          : disposition.startsWith("done") || (disposition === "mixed" && index === 0) ? "done" : "blocked";
        const title = disposition === "blocked-single" ? `  Waiting\n\tfor ${"x".repeat(80)}  ` : `Daily work ${identifier}`;
        const [task] = await db.insert(issues).values({ companyId: c.companyId, identifier,
          title, status, ...(status === "done" ? { completedAt: at } : {}) }).returning();
        await db.insert(chatTaskHandoffs).values({ companyId: c.companyId, taskId: task.id,
          conversationId: c.issueId, agentId: c.agentId, sessionGeneration: 0 });
        const [d] = await db.insert(chatCompletionDeliveries).values({ companyId: c.companyId,
          taskId: task.id, statusVersion: task.statusVersion, status: "pending", attempts: 0,
          createdAt: at, nextAttemptAt: at }).returning();
        ids.push(d.id);
      }
      if (hasHead) await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "automation", reason: "chat_task_completed", requestedByActorType: "system",
        status: "deferred_issue_execution", requestedAt: ago(13 * hour), payload: { issueId: c.issueId,
          chatCompletionDeliveryIds: [ids[0]], _paperclipWakeContext: { issueId: c.issueId,
            taskKey: c.issueId, wakeReason: "chat_task_completed", chatCompletionDeliveryIds: [ids[0]] } } });
      // The saved terminal owner has NO issue lock, exactly as at boot. Use
      // the real stranded-receipt release boundary, without provider execution.
      const previous = await run(c, [], ago(12 * hour));
      await db.insert(nativeRunFinalizations).values({ companyId: c.companyId, issueId: c.issueId,
        runId: previous.id, phase: "committed" });
      const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
        resolveResponsibleUserId: async () => owner,
        getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
        resolveSessionBeforeForWakeup: async () => null,
      }), recovery: {
        escalateStrandedAssignedIssue: async () => { throw new Error("unexpected recovery"); },
        escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("unexpected recovery"); },
      } });
      const service = chatCompletionDeliveryService(db, c.heartbeat);
      const started = Date.now();
      let firstNotes: Awaited<ReturnType<typeof systemNotes>> | undefined;
      for (let pass = 0; pass <= 10; pass++) {
        await boot(c);
        await release({ companyId: c.companyId, runId: previous.id, now: new Date(), resumeStrandedQueue: true,
          suppressImmediateRecovery: true });
        await db.update(chatCompletionDeliveries).set({ nextAttemptAt: new Date(0) })
          .where(eq(chatCompletionDeliveries.companyId, c.companyId));
        await service.sweepPending();
        const persistedNotes = await systemNotes(c);
        if (pass === 0) firstNotes = persistedNotes;
        else expect(persistedNotes, "a second supersede pass writes nothing").toEqual(firstNotes);
        if (process.env.PAPERCLIP_HIS_SHAPE_SOAK === "1" && hasHead && pass < 10)
          await new Promise(resolve => setTimeout(resolve, 60_000));
      }
      const runs = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, c.companyId)))
        .filter(r => r.id !== previous.id);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, c.companyId));
      const rows = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.companyId, c.companyId));
      const notes = await systemNotes(c);
      process.stdout.write(`his-shape persisted ${JSON.stringify({ hasHead, disposition, elapsedMs: Date.now() - started,
        runs: runs.length, wakes: wakes.map(w => ({ id: w.id, status: w.status, runId: w.runId })),
        notes: notes.map(n => n.body),
        deliveries: rows.map(d => ({ id: d.id, status: d.status, attempts: d.attempts })) })}\n`);
      expect(runs, "pre-boot reports must NEVER start a run").toHaveLength(0);
      expect(wakes).toHaveLength(hasHead ? 1 : 0);
      if (hasHead) expect(wakes[0]).toMatchObject({ status: "cancelled", runId: null });
      expect(rows).toHaveLength(identifiers.length);
      expect(rows.every(d => d.status === "superseded")).toBe(true);
      if (disposition === "other") {
        expect(notes).toEqual([]);
      } else {
        expect(notes).toHaveLength(1);
        const expected = disposition === "done"
          ? "Finished earlier (these reports were delayed): SMA-611 — Daily work SMA-611; SMA-618 — Daily work SMA-618; SMA-617 — Daily work SMA-617; and 2 more."
          : disposition === "done-single"
            ? "Finished earlier (this report was delayed): SMA-611 — Daily work SMA-611."
            : disposition === "mixed"
              ? "Finished earlier (this report was delayed): SMA-611 — Daily work SMA-611.\nBlocked, not finished (these reports were delayed): SMA-618 — Daily work SMA-618; SMA-617 — Daily work SMA-617; SMA-615 — Daily work SMA-615; and 1 more."
              : disposition === "blocked-single"
                ? `Blocked, not finished (this report was delayed): SMA-611 — Waiting for ${"x".repeat(47)}….`
                : "Blocked, not finished (these reports were delayed): SMA-611 — Daily work SMA-611; SMA-618 — Daily work SMA-618; SMA-617 — Daily work SMA-617; and 2 more.";
        expect(notes[0].body).toBe(expected);
      }
    }, 11 * 60_000);

    it("boot-4d: platform's five pre-boot shapes yield ONE five-task naming note and ZERO runs", async () => {
      const c = await chat();
      const ids: string[] = [];
      for (let index = 1; index <= 5; index++) {
        const [task] = await db.insert(issues).values({ companyId: c.companyId, identifier: `BOOT-${index}`,
          title: `Finished platform task ${index}`, status: "done", completedAt: ago(5 * hour) }).returning();
        await db.insert(chatTaskHandoffs).values({ companyId: c.companyId, taskId: task.id,
          conversationId: c.issueId, agentId: c.agentId, sessionGeneration: 0 });
        const [delivery] = await db.insert(chatCompletionDeliveries).values({ companyId: c.companyId,
          taskId: task.id, statusVersion: task.statusVersion, status: "queued" }).returning();
        ids.push(delivery.id);
      }
      const [completion] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "automation", reason: "issue_execution_deferred", requestedByActorType: "system",
        status: "deferred_issue_execution", requestedAt: ago(4 * hour), payload: { issueId: c.issueId,
          chatCompletionDeliveryIds: ids, interactionOrigin: { actorType: "system", actorId: "chat_completion_delivery" },
          _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "chat_task_completed" } } }).returning();
      const scopes = [c];
      const held: string[] = [];
      for (let index = 0; index < 4; index++) {
        const done = index === 0;
        const [task] = await db.insert(issues).values({ companyId: c.companyId, title: `Saved wake ${index}`,
          status: done ? "done" : "blocked", assigneeAgentId: c.agentId }).returning();
        const reason = done ? "issue_blocker_stalled" : "issue_commented";
        const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
          source: "automation", reason, requestedByActorType: done ? "system" : "agent",
          requestedByActorId: done ? "monitor" : c.agentId, status: "deferred_issue_execution", requestedAt: ago(4 * hour),
          payload: { issueId: task.id, _paperclipWakeContext: { issueId: task.id, taskKey: task.id, wakeReason: reason } } }).returning();
        held.push(w.id); scopes.push({ ...c, issueId: task.id });
      }
      for (const scope of scopes) await busyFinalization(scope, await run(scope, [], ago(hour)));
      for (let pass = 0; pass < 2; pass++) for (const scope of scopes) await settleSavedOwner(scope);
      // Opt-in wall-clock boot soak for the platform's boot + 10 minute row.
      // The ordinary regression remains quick; the evidence run uses the same
      // rows and repeats the real sweep after ten minutes, not a clock mock.
      if (process.env.PAPERCLIP_COMPLETION_BOOT_SOAK === "1") {
        console.info("boot-4d soak started", new Date().toISOString());
        await new Promise(resolve => setTimeout(resolve, 10 * 60_000));
        for (const scope of scopes) await settleSavedOwner(scope);
        console.info("boot-4d soak finished", new Date().toISOString());
      }
      expect(await queuedRuns(completion.id)).toEqual([]);
      expect(await wake(completion.id)).toMatchObject({ status: "cancelled", runId: null });
      for (const id of held) {
        expect(await queuedRuns(id)).toEqual([]);
        expect(await wake(id)).toMatchObject({ status: "deferred_issue_execution", runId: null });
      }
      const notes = await systemNotes(c);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe("Finished earlier (these reports were delayed): BOOT-1 — Finished platform task 1; BOOT-2 — Finished platform task 2; BOOT-3 — Finished platform task 3; and 2 more.");
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
        inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"])))).toEqual([]);
    }, 11 * 60_000);

    it("boot-person: a pre-boot system envelope carrying OWED person input still promotes once", async () => {
      const c = await chat();
      const m = await message(c, "Owed person input from before restart", ago(4 * hour));
      const w = await deferred(c, m.id, m.createdAt);
      await db.update(agentWakeupRequests).set({ requestedByActorType: "system" }).where(eq(agentWakeupRequests.id, w.id));
      const ownerRun = await run(c, [], ago(hour));
      await busyFinalization(c, ownerRun);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await queuedRuns(w.id)).toHaveLength(1);
      expect((await queuedRuns(w.id))[0].contextSnapshot).toMatchObject({ wakeCommentIds: [m.id] });
      expect(await systemNotes(c)).toEqual([]);
    });

    it("post-boot-auto: automation requested during the live turn still promotes", async () => {
      const c = await chat();
      const ownerRun = await run(c, [], ago(10 * 60_000));
      const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "automation", triggerDetail: "system", reason: "automation_no_new_person", requestedByActorType: "system",
        status: "deferred_issue_execution", requestedAt: new Date(), payload: { issueId: c.issueId,
          _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId, wakeReason: "automation_no_new_person" } } }).returning();
      await busyFinalization(c, ownerRun);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      expect(await queuedRuns(w.id)).toHaveLength(1);
    });

    it("ib-a: sweep drains a fresh person message after busy finalization; one answer, no card or boot resend", async () => {
      const c = await chat();
      const initial = await message(c, "Current daily work", ago(hour));
      const current = await run(c, [initial.id], ago(59 * 60_000), "succeeded", ago(10 * 60_000));
      const m = await message(c, "Please answer the new question", ago(30 * 60_000));
      const w = await deferred(c, m.id, m.createdAt);
      await reply(c, current, "Current work finished");
      await busyFinalization(c, current);
      expect(await queuedRuns(w.id)).toEqual([]);
      const started = Date.now();
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      const elapsedMs = Date.now() - started;
      const admitted = await queuedRuns(w.id);
      console.info("ib-a drain", JSON.stringify({ elapsedMs, wakeStatus: (await wake(w.id)).status,
        runs: admitted.map(r => ({ id: r.id, context: r.contextSnapshot })) }));
      expect(admitted).toHaveLength(1);
      expect(elapsedMs).toBeLessThan(5_000);
      expect(admitted[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeCommentIds: [m.id] } });
      const [answered] = await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, admitted[0].id)).returning();
      await reply(c, answered, "Answer to the new question");
      await settleConversationTurn(db, answered);
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.id, w.id));
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await boot(c); await unansweredSweep(c);
      }
      expect(await queuedRuns(w.id)).toHaveLength(1);
      expect(await systemNotes(c)).toEqual([]);
      const answers = await db.select().from(issueComments).where(and(eq(issueComments.issueId, c.issueId),
        eq(issueComments.createdByRunId, answered.id), eq(issueComments.authorType, "agent")));
      expect(answers.map(a => a.body)).toEqual(["Answer to the new question"]);
      console.info("ib-a answer once; cards 0; repeated boot sends 0");
    });

    it("ib-b: SMA-4 sweep cancels the hours-old completion batch; five deliveries superseded, ONE naming note, M untouched", async () => {
      const c = await chat();
      const identifiers = ["SMA-611", "SMA-615", "SMA-616", "SMA-617", "SMA-618"];
      const deliveries = [];
      for (const identifier of identifiers) {
        const [task] = await db.insert(issues).values({ companyId: c.companyId, identifier,
          title: `Daily work ${identifier}`, status: "done", completedAt: ago(5 * hour) }).returning();
        await db.insert(chatTaskHandoffs).values({ companyId: c.companyId, taskId: task.id,
          conversationId: c.issueId, agentId: c.agentId, sessionGeneration: 0 });
        const [d] = await db.insert(chatCompletionDeliveries).values({ companyId: c.companyId,
          taskId: task.id, statusVersion: task.statusVersion, status: "queued" }).returning();
        deliveries.push(d.id);
      }
      const [w] = await db.insert(agentWakeupRequests).values({ companyId: c.companyId, agentId: c.agentId,
        source: "automation", reason: "chat_task_completed", requestedByActorType: "system",
        status: "deferred_issue_execution", requestedAt: ago(4 * hour), payload: { issueId: c.issueId,
          chatCompletionDeliveryIds: deliveries, _paperclipWakeContext: { issueId: c.issueId, taskKey: c.issueId,
            wakeReason: "chat_task_completed", chatCompletionDeliveryIds: deliveries } } }).returning();
      const m = await message(c, "M: What should I do next?", ago(3 * hour));
      const mw = await deferred(c, m.id, m.createdAt);
      const answered = await run(c, [m.id], ago(179 * 60_000));
      await db.update(heartbeatRuns).set({ wakeupRequestId: mw.id }).where(eq(heartbeatRuns.id, answered.id));
      await db.update(agentWakeupRequests).set({ status: "completed", runId: answered.id, finishedAt: answered.finishedAt })
        .where(eq(agentWakeupRequests.id, mw.id));
      await reply(c, answered, "M's current answer");
      const mBefore = await wake(mw.id);
      const finalizer = await run(c, [], ago(10 * 60_000));
      await busyFinalization(c, finalizer);
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await boot(c); await unansweredSweep(c);
      }
      const lateRuns = await queuedRuns(w.id);
      const ds = await db.select().from(chatCompletionDeliveries).where(eq(chatCompletionDeliveries.companyId, c.companyId));
      const notes = await systemNotes(c);
      console.info("ib-b persisted", JSON.stringify({ wake: await wake(w.id), lateRuns: lateRuns.map(r => r.id),
        deliveries: ds.map(d => ({ id: d.id, status: d.status })), notes: notes.map(n => n.body) }));
      expect(lateRuns, "NO late report turn").toEqual([]);
      expect(await wake(w.id)).toMatchObject({ status: "cancelled", error: "The conversation moved on", runId: null });
      expect(ds).toHaveLength(5); expect(ds.every(d => d.status === "superseded")).toBe(true);
      expect(notes).toHaveLength(1);
      expect(notes[0].body).toBe("Finished earlier (these reports were delayed): SMA-611 — Daily work SMA-611; SMA-615 — Daily work SMA-615; SMA-616 — Daily work SMA-616; and 2 more.");
      expect(await wake(mw.id)).toEqual(mBefore);
      expect(await queuedRuns(mw.id)).toHaveLength(1);
      expect((await issue(c)).executionRunId).toBeNull();
    });

    it("ib-c: sweep cancels moved-on input carried by a failed run; no new run, no card", async () => {
      const c = await chat();
      const old = await message(c, "Old request carried before the failure", ago(2 * day));
      const w = await deferred(c, old.id, old.createdAt);
      const failed = await run(c, [old.id], ago(2 * day - 60_000), "failed");
      const m = await message(c, "Later daily work", ago(day));
      const answered = await run(c, [m.id], ago(day - 60_000)); await reply(c, answered, "Later work answered");
      await busyFinalization(c, answered);
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await boot(c); await unansweredSweep(c);
      }
      expect(await wake(w.id)).toMatchObject({ status: "cancelled", runId: null, error: "The conversation moved on" });
      expect(await queuedRuns(w.id)).toEqual([]); expect(await systemNotes(c)).toEqual([]);
      const carriers = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${old.id}`));
      expect(carriers.map(r => r.id)).toEqual([failed.id]);
      console.info("ib-c cancelled; only original failed carrier; new runs 0; cards 0");
    });

    it("ib-4bii: fresh M in a stale batch survives a later system-only reply and is delivered ONCE, not carded", async () => {
      const c = await chat();
      const original = await message(c, "Original batch input", ago(5 * hour));
      const w = await deferred(c, original.id, ago(4 * hour));
      const n = await message(c, "N: older answered direction", ago(3 * hour));
      const answered = await run(c, [original.id, n.id], ago(2 * hour));
      await reply(c, answered, "Original input and N answered");
      const m = await message(c, "M: fresh input appended to the batch", ago(hour));
      await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(w.payload,
        [original.id, n.id, m.id]), coalescedCount: 2 }).where(eq(agentWakeupRequests.id, w.id));
      const system = await run(c, [], ago(30 * 60_000));
      await reply(c, system, "Automatic update, not an answer to person input");
      await busyFinalization(c, system);
      await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
      // Inspect the actual drain BEFORE any boot outbox can repair its mistake.
      const admitted = await queuedRuns(w.id);
      console.info("ib-4bii drain", JSON.stringify({ wakeStatus: (await wake(w.id)).status,
        runs: admitted.map(r => ({ id: r.id, context: r.contextSnapshot })), notes: await systemNotes(c) }));
      expect(admitted, "Fresh M must be delivered, not retired by the system reply").toHaveLength(1);
      expect(admitted[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeCommentIds: [m.id] } });
      const [finished] = await db.update(heartbeatRuns).set({ status: "succeeded", startedAt: new Date(), finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, admitted[0].id)).returning();
      await reply(c, finished, "M answered once"); await settleConversationTurn(db, finished);
      await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, w.id));
      for (let pass = 0; pass < 2; pass++) {
        await c.heartbeat.sweepStaleIssueLocks({ companyId: c.companyId, issueId: c.issueId });
        await boot(c); await unansweredSweep(c);
      }
      expect(await queuedRuns(w.id)).toHaveLength(1); expect(await systemNotes(c)).toEqual([]);
      console.info("ib-4bii M answered once; cards 0; no duplicate after boot");
    });

    it("R2: boot stranded sweep never re-sends a days-old failed-carried message without a wake receipt", async () => {
      const c = await chat();
      const old = await message(c, "Days-old carried input with no receipt", ago(3 * day));
      await run(c, [old.id], ago(3 * day - 60_000), "failed");
      const m = await message(c, "Later direction", ago(day));
      const answered = await run(c, [m.id], ago(day - 60_000)); await reply(c, answered, "Later direction answered");
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, c.companyId))).toEqual([]);
      const enqueue = vi.fn(c.heartbeat.wakeup);
      for (let pass = 0; pass < 2; pass++) { await boot(c, enqueue); await unansweredSweep(c); }
      const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, c.companyId));
      console.info("R2 real boot", JSON.stringify({ enqueueCalls: enqueue.mock.calls.length,
        receipts: receipts.map(w => ({ id: w.id, status: w.status, key: w.idempotencyKey })), notes: await systemNotes(c) }));
      expect(enqueue).not.toHaveBeenCalled(); expect(receipts).toEqual([]); expect(await systemNotes(c)).toEqual([]);
    });

    it("R2-stale-unclaimed: a cancelled never-carried old wake stays retired at boot and owes just ONE naming card", async () => {
      const c = await chat();
      const old = await message(c, "Old request never carried", ago(2 * day));
      const w = await deferred(c, old.id, old.createdAt);
      await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: ago(day) })
        .where(eq(agentWakeupRequests.id, w.id));
      const m = await message(c, "Newer daily direction", ago(day));
      const answered = await run(c, [m.id], ago(day - 60_000)); await reply(c, answered, "Newer direction answered");
      const enqueue = vi.fn(c.heartbeat.wakeup);
      for (let pass = 0; pass < 2; pass++) { await boot(c, enqueue); await unansweredSweep(c); }
      expect(enqueue).not.toHaveBeenCalled(); expect(await queuedRuns(w.id)).toEqual([]);
      const notes = await systemNotes(c);
      expect(notes).toHaveLength(1); expect(notes[0].body).toContain(`Your message is saved: "${old.body}".`);
      expect(notes[0].body).toContain("no run started for it");
      console.info("R2-stale-unclaimed boot sends 0; ONE naming card:", notes[0].body);
    });

    it("R2-pause: unclaimed M cancelled by an agent pause stays owed and boot delivers it ONCE after resume", async () => {
      const c = await chat();
      const initial = await message(c, "Current turn", ago(hour));
      const current = await run(c, [initial.id], ago(59 * 60_000), "succeeded", ago(10 * 60_000));
      const m = await message(c, "M saved during the current turn", ago(30 * 60_000));
      const w = await deferred(c, m.id, m.createdAt);
      // The current reply predates no newer START: M arrived during this run.
      await reply(c, current, "Current turn finished");
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, c.agentId));
      expect(await c.heartbeat.cancelInvocationsForAgents([c.agentId], "Agent paused"))
        .toMatchObject({ runsCancelled: 0, wakeupsCancelled: 1 });
      expect((await wake(w.id)).runId).toBeNull();
      const enqueue = vi.fn(c.heartbeat.wakeup);
      await boot(c, enqueue); expect(enqueue).not.toHaveBeenCalled();
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, c.agentId));
      for (let pass = 0; pass < 2; pass++) await boot(c, enqueue);
      const carriers = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, c.companyId),
        sql`coalesce(${heartbeatRuns.contextSnapshot}->'wakeCommentIds', '[]'::jsonb) ? ${m.id}`));
      console.info("R2-pause resumed", JSON.stringify({ enqueueCalls: enqueue.mock.calls.length,
        carriers: carriers.map(r => ({ id: r.id, status: r.status, context: r.contextSnapshot })) }));
      expect(enqueue).toHaveBeenCalledOnce(); expect(carriers).toHaveLength(1);
      expect(carriers[0]).toMatchObject({ status: "queued", contextSnapshot: { wakeCommentIds: [m.id] } });
      await unansweredSweep(c); expect(await systemNotes(c)).toEqual([]);
    });
  });
});
