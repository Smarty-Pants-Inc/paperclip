import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { activityLog, agentWakeupRequests, agents, chatCompletionDeliveries, chatTaskHandoffs, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../../../__tests__/helpers/external-test-database.js";
import { createQueuedCommentIssueLockWriter } from "./queued-comment-postgres.js";
import type { QueuedCommentQueuePostgresAdapterDeps } from "./queued-comment-postgres.js";
import { QueuedCommentMutationError } from "../application/queued-comment-use-cases.js";
import { buildAgentMentionHref } from "@paperclipai/shared";
import { createQueuedCommentSteeringAdapter } from "./queued-comment-board-postgres.js";
import { appendHeartbeatRunEventBatch } from "../../../services/heartbeat-run-events.js";
import { chatCompletionDeliveryService } from "../../../services/chat-completion-delivery.js";

// Proves the same two properties the release-half adapter test proves for
// this module's other transaction: the one company the caller names in
// `issue.companyId` binds every read and write for the whole transaction, so
// a caller-supplied `issue`/`wake` for the wrong company sees nothing, and a
// guarded write that affects no row rolls the transaction back instead of
// leaving a partial write. The decision branching itself is proven against
// plain facts in `domain/policy.test.ts`; the use-case orchestration is
// proven against a mocked port in `application/queued-comment-use-cases.test.ts`.
const external = resolveExternalTestDatabaseUrl("PAPERCLIP_QUEUED_COMMENT_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres queued-comment adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("queued-comment postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const noopDeps: QueuedCommentQueuePostgresAdapterDeps = {
    syncCommentReferences: async () => {},
    deleteCommentReferenceSource: async () => {},
    syncCommentExternalObjectsSafely: async () => {},
  };

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-queued-comment-postgres-adapter-");
    db = createDb(external ?? tempDb!.connectionString);
  }, 20_000);

  afterEach(async () => {
    // Deleted first: activity_log rows reference companies, agents, and
    // heartbeat_runs, and none of those foreign keys cascade.
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
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

  async function seedAgent(input: { companyId: string; adapterType?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: input.adapterType ?? "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: { companyId: string; assigneeAgentId: string | null }): Promise<string> {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Queued-comment adapter fixture issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId,
    });
    return issueId;
  }

  async function seedComment(input: { companyId: string; issueId: string; authorUserId: string }): Promise<string> {
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId: input.companyId,
      issueId: input.issueId,
      authorUserId: input.authorUserId,
      body: "queued message",
    });
    return commentId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    commentIds: string[];
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      payload: {
        issueId: input.issueId,
        _paperclipWakeContext: { wakeCommentIds: input.commentIds },
      },
    });
    return id;
  }

  it("commits native run events while the steering board and agent permission check hold the issue lock", async () => {
    // Regression: board ISSUE(UPDATE) -> RUN(UPDATE) opposed the event writer's
    // RUN(NO KEY UPDATE) -> ISSUE(KEY SHARE). Exercise both real lock sites.
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    await db.update(issueComments).set({ authorUserId: null, authorAgentId: agentId, authorType: "agent" })
      .where(eq(issueComments.id, commentId));
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId } });
    let markLocked!: () => void, failLocked!: (error: unknown) => void, releaseBoard!: () => void;
    const locked = new Promise<void>((resolve, reject) => { markLocked = resolve; failLocked = reject; });
    const release = new Promise<void>(resolve => { releaseBoard = resolve; });
    let boardReleased = false;
    const board = createQueuedCommentSteeringAdapter(db).withLockedTarget({
      issue: { id: issueId, companyId }, queueId: wakeId, commentId, targetRunId: runId, revision: "fixture",
      actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
    }, async tx => {
      await tx.assertDeliveryAllowed(); // Must not upgrade the board's issue lock.
      markLocked();
      await release;
      boardReleased = true;
    });
    // Propagate startup errors rather than leaving the readiness wait hanging.
    void board.catch(failLocked);
    try {
      await locked;
      const receipts = await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.execute(sql`set local statement_timeout = '3s'`);
        // Two native appends on an uncursored run take the fallback transaction;
        // the second run UPDATE rechecks the issue FK, as in the logged cycle.
        const sourceInstanceId = randomUUID();
        return appendHeartbeatRunEventBatch(tx as unknown as Db, [1, 2].map(sourceSeq => ({
          companyId, agentId, runId, eventType: "test.lock_compatibility",
          nativeSource: { sourceInstanceId, sourceEventId: randomUUID(), sourceSeq,
            protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
        })));
      });
      expect(boardReleased).toBe(false);
      expect(receipts.map(receipt => receipt.disposition)).toEqual(["committed", "committed"]);
      expect(receipts.map(receipt => receipt.row.seq)).toEqual([1, 2]);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.nextEventSeq).toBe(3);
    } finally {
      releaseBoard();
      await board;
    }
  });

  it("commits native event appends while deliverIntoLiveTurn holds both issue locks", async () => {
    const companyId = await seedCompany(), agentId = await seedAgent({ companyId });
    const sourceId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const taskId = await seedIssue({ companyId, assigneeAgentId: agentId });
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "user-1", conversationState: "waiting" })
      .where(eq(issues.id, sourceId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, taskId));
    await db.insert(chatTaskHandoffs).values({ companyId, taskId, conversationId: sourceId, agentId, sessionGeneration: 0 });
    const [delivery] = await db.insert(chatCompletionDeliveries).values({ companyId, taskId, statusVersion: 0 }).returning();
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation",
      status: "deferred_issue_execution", idempotencyKey: `chat-completion:${delivery!.id}:0` });
    const runs = [taskId, sourceId].map(issueId => ({ id: randomUUID(), companyId, agentId, issueId, nativeIssueId: issueId,
      status: "running", runtimeMode: "native", contextSnapshot: { issueId } }));
    await db.insert(heartbeatRuns).values(runs);
    let markLocked!: () => void, failLocked!: (error: unknown) => void, releaseDelivery!: () => void;
    const locked = new Promise<void>((resolve, reject) => { markLocked = resolve; failLocked = reject; });
    const release = new Promise<void>(resolve => { releaseDelivery = resolve; });
    const lockedIssueIds: string[] = [];
    let deliveryReleased = false;
    // Pause the real service after its second issue lock, preserving both SQL
    // modes. No provider is needed: lock compatibility is tested before I/O.
    function observeSelect(builder: object): object {
      return new Proxy(builder, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "for") return async (...args: unknown[]) => {
          const rows = await Reflect.apply(value, target, args) as Array<{ id: string }>;
          lockedIssueIds.push(rows[0]!.id);
          if (lockedIssueIds.length === 2) {
            markLocked();
            await release;
            deliveryReleased = true;
          }
          return rows;
        };
        if (key === "from" || key === "where") return (...args: unknown[]) => observeSelect(Reflect.apply(value, target, args));
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }
    const observingDb = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key, target);
      return (work: (tx: Db) => Promise<unknown>) => target.transaction(async tx => {
        const observed = new Proxy(tx, { get(inner, property) {
          if (property !== "select") return Reflect.get(inner, property, inner);
          return (...args: unknown[]) => observeSelect(Reflect.apply(inner.select, inner, args));
        } });
        return work(observed as unknown as Db);
      });
    } });
    const delivering = chatCompletionDeliveryService(observingDb, { wakeup: async () => {
      throw new Error("Existing deferred wake must be reused");
    } }).deliver(delivery!.id);
    void delivering.then(() => failLocked(new Error("Delivery ended before both issue locks")), failLocked);
    try {
      await locked;
      expect(lockedIssueIds).toEqual([taskId, sourceId]);
      // Both referenced issues must permit FK KEY SHARE, not just the chat.
      // Two native appends force the same run-update/FK recheck as seam 0324.
      const appended = await Promise.allSettled(runs.map(run => db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '750ms'`);
        await tx.execute(sql`set local statement_timeout = '3s'`);
        const sourceInstanceId = randomUUID();
        return appendHeartbeatRunEventBatch(tx as unknown as Db, [1, 2].map(sourceSeq => ({
          companyId, agentId, runId: run.id, eventType: "test.completion_lock_compatibility",
          nativeSource: { sourceInstanceId, sourceEventId: randomUUID(), sourceSeq,
            protocolSchemaVersion: 1, canonicalPayload: { sourceSeq } },
        })));
      })));
      console.info("completion-lock-row", { taskId, sourceId, lockedIssueIds, deliveryReleased,
        appends: appended.map((result, index) => ({ issueId: runs[index]!.issueId, runId: runs[index]!.id,
          status: result.status, ...(result.status === "fulfilled"
            ? { seqs: result.value.map(receipt => receipt.row.seq) }
            : { error: String(result.reason), cause: String(result.reason?.cause) }) })) });
      expect(deliveryReleased).toBe(false);
      for (const result of appended) {
        expect(result.status).toBe("fulfilled");
        if (result.status === "fulfilled") {
          expect(result.value.map(receipt => receipt.disposition)).toEqual(["committed", "committed"]);
          expect(result.value.map(receipt => receipt.row.seq)).toEqual([1, 2]);
        }
      }
      for (const run of runs) {
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]?.nextEventSeq).toBe(3);
        expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).toHaveLength(2);
      }
    } finally { releaseDelivery(); await delivering; }
  });

  it("checks the authenticated editor and changed mentions atomically before updating a queued comment", async () => {
    const companyId = await seedCompany();
    const recipient = await seedAgent({ companyId }), sender = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: recipient });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId: recipient, issueId, commentIds: [commentId] });
    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const input = { issue: { id: issueId, companyId, assigneeAgentId: recipient, executionRunId: null },
      actor: { actorType: "agent" as const, actorId: sender, agentId: sender, runId: null, agentApiKeyId: null }, queueId: wakeId };
    await db.update(agents).set({ permissions: { interactions: { canMentionAgents: false } } }).where(eq(agents.id, sender));
    await expect(issueLock.withLockedQueue(input, async (_locked, tx) => tx.updateCommentBody({ issueId, commentId,
      body: `[@Recipient](${buildAgentMentionHref(recipient)})`, updatedAt: new Date() }))).rejects.toMatchObject({ status: 403,
        details: expect.objectContaining({ permission: "canMentionAgents", actorAgentId: sender }) });
    await db.update(agents).set({ permissions: { interactions: { canReceiveCommentsFromAgents: false } } }).where(eq(agents.id, recipient));
    await expect(issueLock.withLockedQueue(input, async (_locked, tx) => tx.deleteComment({ issueId, commentId })))
      .rejects.toMatchObject({ status: 403, details: expect.objectContaining({ permission: "canReceiveCommentsFromAgents" }) });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0]?.body).toBe("queued message");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0]?.payload)
      .toMatchObject({ _paperclipWakeContext: { wakeCommentIds: [commentId] } });
    await issueLock.withLockedQueue({ ...input, actor: { ...input.actor, actorType: "user", actorId: "user-1", agentId: null } },
      async (_locked, tx) => tx.updateCommentBody({ issueId, commentId, body: "Human edit", updatedAt: new Date() }));
    expect((await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0]?.body).toBe("Human edit");
  });

  it("scopes the wake lookup to its own company: a foreign-company issue context resolves not_pending and deletes nothing", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    await expect(
      issueLock.withLockedQueue(
        {
          // The caller mistakenly names the *other* company on the issue
          // context; that single value binds every read and write for the
          // whole transaction, so it alone must decide what is visible.
          issue: { id: issueId, companyId: otherCompanyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async () => {
          throw new Error("fn must not run when the wake is invisible to the caller's company");
        },
      ),
    ).rejects.toMatchObject({ code: "queued_comment_not_pending" });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.deletedAt ?? null).toBeNull();
    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
  });

  it("rolls back a discard when the comment id given belongs to a different issue than the one this transaction locked", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const otherIssueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId: otherIssueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    await expect(
      issueLock.withLockedQueue(
        {
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async (_locked, transaction) => {
          // The comment belongs to a different issue than the one this
          // transaction locked. The write's own `issueId` predicate, not
          // just the bound company, must decide what is visible.
          const deleted = await transaction.deleteComment({ issueId, commentId });
          if (!deleted) {
            throw new QueuedCommentMutationError("queued_comment_not_pending", "The queued message is no longer pending");
          }
          return deleted;
        },
      ),
    ).rejects.toMatchObject({ code: "queued_comment_not_pending" });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow).toBeDefined();
    expect(commentRow?.deletedAt ?? null).toBeNull();
  });

  it("edits the comment body, syncs references, and rebuilds the queue snapshot inside one company-scoped transaction", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    let syncedCommentId: string | null = null;
    const deps: QueuedCommentQueuePostgresAdapterDeps = {
      ...noopDeps,
      syncCommentReferences: async (id) => {
        syncedCommentId = id;
      },
    };
    const issueLock = createQueuedCommentIssueLockWriter(db, deps);

    const queue = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked, transaction) => {
        expect(locked.state).toBe("deferred");
        const updated = await transaction.updateCommentBody({
          issueId,
          commentId,
          body: "edited body",
          updatedAt: new Date(),
        });
        expect(updated).toBe(true);
        await transaction.syncCommentReferences(commentId);
        return transaction.buildQueueSnapshot({
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          wake: locked.wake,
          state: locked.state,
          queueRun: locked.queueRun,
          activeRun: locked.activeRun,
        });
      },
    );

    expect(syncedCommentId).toBe(commentId);
    expect(queue.entries).toHaveLength(1);
    expect((queue.entries[0]!.comment as { body: string }).body).toBe("edited body");
    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.body).toBe("edited body");
  });

  it("rolls back an already-applied comment edit when its own activity insert fails", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const missingAgentId = randomUUID();

    await expect(
      issueLock.withLockedQueue(
        {
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          queueId: wakeId,
        },
        async (_locked, transaction) => {
          await transaction.updateCommentBody({
            issueId,
            commentId,
            body: "edited body",
            updatedAt: new Date(),
          });
          // `agentId` carries a foreign key to `agents.id`; naming an agent
          // that was never seeded forces the activity insert to fail, which
          // must roll back the comment edit issued moments earlier on the
          // same transaction.
          await transaction.logActivity({
            actorType: "agent",
            actorId: missingAgentId,
            agentId: missingAgentId,
            runId: null,
            agentApiKeyId: null,
            action: "issue.queued_comment_edited",
            entityId: issueId,
            details: {},
          });
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const commentRow = (await db.select().from(issueComments).where(eq(issueComments.id, commentId)))[0];
    expect(commentRow?.body).toBe("queued message");
    const activityRows = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activityRows).toHaveLength(0);
  });

  // Pins a fact the database itself cannot persist today: `runtime_mode` is
  // a NOT NULL column, so a real active run's own field is never null. The
  // port type allows it (`runtimeMode: string | null`), so this test builds
  // the fact directly instead of through a database row, to keep this
  // branch of the shared steering rule under a regression test.
  it("answers the steering question for a deferred paperclip_runner queue whose active run has no persisted runtime mode yet", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId, adapterType: "paperclip_runner" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const commentId = await seedComment({ companyId, issueId, authorUserId: "user-1" });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId, commentIds: [commentId] });

    const issueLock = createQueuedCommentIssueLockWriter(db, noopDeps);
    const queue = await issueLock.withLockedQueue(
      {
        issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
        actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
        queueId: wakeId,
      },
      async (locked, transaction) => {
        expect(locked.state).toBe("deferred");
        return transaction.buildQueueSnapshot({
          issue: { id: issueId, companyId, assigneeAgentId: agentId, executionRunId: null },
          actor: { actorType: "user", actorId: "user-1", agentId: null, runId: null, agentApiKeyId: null },
          wake: locked.wake,
          state: "deferred",
          queueRun: null,
          activeRun: { id: randomUUID(), status: "running", runtimeMode: null, contextSnapshot: {} },
        });
      },
    );

    expect(queue.protocol).toBe("paperclip_runner_v1");
    expect(queue.steeringDisposition).toBe("temporarily_unavailable");
  });
});
