import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { pendingContinuationCommentInput, readContinuationCommentInput } from "./continuation-comment-input.js";
import { materializeNativeProviderCapacityRetry } from "./native-runtime/native-provider-capacity-retry.js";
import { claimFirstTurnQueuedInput } from "./native-runtime/first-turn-queued-input.js";
import { firstTurnDeliveredCommentIds } from "./queued-comment-delivery.js";

// DREA-31 / data safety: exercise persisted input and answer attribution, not SQL text.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("continuation pending person input", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("continuation-input-"); db = createDb(database.connectionString); }, 20_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Carry input", issuePrefix: `C${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Agent", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Continue", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [message] = await db.insert(issueComments).values({ companyId: company.id, issueId: issue.id, authorType: "user", authorUserId: "board", body: "Recall COBALT" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, nativeIssueId: issue.id,
      runtimeMode: "native", status: "failed", responsibleUserId: "board", contextSnapshot: { issueId: issue.id, wakeCommentId: message.id } }).returning();
    return { companyId: company.id, issueId: issue.id, agentId: agent.id, run, message };
  }

  it("rebinds accepted-but-unanswered first-turn input and source wake ids to the capacity retry", async () => {
    const f = await fixture();
    const wakeId = randomUUID();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId,
      firstTurnQueuedInput: { schema: "paperclip.first-turn-queued-input.v1", runId: f.run.id,
        claimedAt: new Date().toISOString(), commentIds: [f.message.id], wakeupRequestIds: [wakeId] } } }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, runId: f.run.id, agentId: f.agentId,
      seq: 1, eventType: "turn.started", payload: {} });
    expect(await firstTurnDeliveredCommentIds(db, { ...f, runId: f.run.id, commentIds: [f.message.id] })).toEqual(new Set([f.message.id]));
    const retryId = await db.transaction(tx => materializeNativeProviderCapacityRetry({ tx: tx as unknown as Db, ...f, runId: f.run.id }));
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(retry.contextSnapshot).toMatchObject({ wakeCommentId: f.message.id, wakeCommentIds: [f.message.id],
      queuedCommentSourceWakeIds: [wakeId], firstTurnQueuedInput: null, commentContinuation: true });
    await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: f.issueId }).where(eq(heartbeatRuns.id, retryId));
    await db.update(issues).set({ executionRunId: retryId }).where(eq(issues.id, f.issueId));
    expect(await claimFirstTurnQueuedInput(db, { ...f, runId: retryId })).toContain("Recall COBALT");
    const [sealed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retryId));
    expect(sealed.contextSnapshot?.firstTurnQueuedInput).toMatchObject({ runId: retryId, commentIds: [f.message.id], wakeupRequestIds: [wakeId] });
  });

  it("removes an attributed answer, not an unrelated later run's reply, and keeps an empty comment-origin marker", async () => {
    const f = await fixture();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId: f.issueId } }).returning();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: other.id, body: "Unrelated work" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ wakeCommentIds: [f.message.id] });
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.run.id, body: "COBALT" });
    expect(await readContinuationCommentInput(db, { ...f, runId: f.run.id })).toMatchObject({ commentContinuation: true, wakeCommentIds: [], wakeCommentId: null });
  });

  it("keeps only live person input within the source company and task", async () => {
    const f = await fixture(), foreign = await fixture();
    const [deleted, agentComment] = await db.insert(issueComments).values([
      { companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: "board", body: "Deleted", deletedAt: new Date() },
      { companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId, body: "Agent work", createdAt: new Date(Date.now() - 60_000) },
    ]).returning();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: {
      wakeCommentIds: ["malformed-id", foreign.message.id, deleted.id, agentComment.id, f.message.id, f.message.id],
    } })).toMatchObject({ wakeCommentIds: [f.message.id] });
    expect(await readContinuationCommentInput(db, { ...foreign, runId: f.run.id })).toEqual({});
    expect(await readContinuationCommentInput(db, { ...f, issueId: foreign.issueId, runId: f.run.id })).toEqual({});
  });

  it("does not claim carried input when another run owns the task", async () => {
    const f = await fixture();
    const context = await readContinuationCommentInput(db, { ...f, runId: f.run.id });
    await db.update(heartbeatRuns).set({ status: "running", contextSnapshot: { issueId: f.issueId, ...context } })
      .where(eq(heartbeatRuns.id, f.run.id));
    expect(await claimFirstTurnQueuedInput(db, { ...f, runId: f.run.id })).toBeNull();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.contextSnapshot?.firstTurnQueuedInput).toMatchObject({ commentIds: [] });
  });

  it("does not manufacture comment intent for ordinary work", async () => {
    const f = await fixture();
    expect(await pendingContinuationCommentInput(db, { ...f, contextSnapshot: { issueId: f.issueId, wakeReason: "issue_assigned" } })).toEqual({});
    // No source run is an initial assignment, not a comment continuation.
    expect(await readContinuationCommentInput(db, { ...f, runId: null })).toEqual({});
  });
});
