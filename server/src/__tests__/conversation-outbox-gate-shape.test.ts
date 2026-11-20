import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { undeliveredConversationComments } from "../services/agent-conversations.js";
import { personMessageOwedSql } from "../services/person-message-answer.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("conversation outbox with gate-sized saved run contexts", () => {
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const pendingId = randomUUID();
  const answeredId = randomUUID();

  beforeAll(async () => {
    postgres = await startEmbeddedPostgresTestDatabase("paperclip-outbox-gate-shape-");
    db = createDb(postgres.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Outbox gate shape" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Outbox agent", role: "engineer", status: "idle" });
    const taskIds = [issueId, ...Array.from({ length: 746 }, () => randomUUID())];
    for (let offset = 0; offset < taskIds.length; offset += 100) {
      await db.insert(issues).values(taskIds.slice(offset, offset + 100).map(id => ({ id, companyId, title: "Saved task" })));
    }
    const sentIds = Array.from({ length: 400 }, () => randomUUID());
    const old = new Date(Date.now() - 86_400_000);
    const runRows: (typeof heartbeatRuns.$inferInsert)[] = [];
    for (let index = 0; index < 1981; index++) {
      const taskId = index < sentIds.length ? issueId : taskIds[1 + index % 746]!;
      runRows.push({
        companyId, agentId, nativeIssueId: taskId, status: "succeeded", runtimeMode: "native",
        contextSnapshot: {
          issueId: taskId,
          wakeCommentId: sentIds[index] ?? randomUUID(),
          // High entropy prevents the unrealistically tiny TOAST of repeat('x', 30000).
          savedLaunchInput: randomBytes(22_500).toString("base64"),
          ...(index === 0 ? { steeredCommentIds: [answeredId], answeredSteeredCommentIds: [answeredId] } : {}),
        },
        createdAt: old, updatedAt: old, startedAt: old, finishedAt: old,
      });
    }
    for (let offset = 0; offset < runRows.length; offset += 25) {
      await db.insert(heartbeatRuns).values(runRows.slice(offset, offset + 25));
    }
    const wakeRows: (typeof agentWakeupRequests.$inferInsert)[] = Array.from({ length: 2595 }, (_, index) => ({
      companyId, agentId, source: "on_demand", status: "completed",
      idempotencyKey: index < sentIds.length ? `conversation-comment:${sentIds[index]}` : null,
      payload: { issueId: taskIds[index % taskIds.length] },
    }));
    for (let offset = 0; offset < wakeRows.length; offset += 100) {
      await db.insert(agentWakeupRequests).values(wakeRows.slice(offset, offset + 100));
    }
    const commentRows: (typeof issueComments.$inferInsert)[] = sentIds.map(id => ({
      id, companyId, issueId, body: "Already sent", authorType: "user", authorUserId: "outbox-owner",
      origin: "comment", clientRequestId: randomUUID(), createdAt: old,
    }));
    // No receipt: one message is genuinely pending, the other was answered by a streamed steer.
    for (const id of [pendingId, answeredId]) commentRows.push({
      id, companyId, issueId, body: "Saved input", authorType: "user", authorUserId: "outbox-owner",
      origin: "comment", clientRequestId: randomUUID(),
    });
    while (commentRows.length < 4111) commentRows.push({
      companyId, issueId: taskIds[1 + commentRows.length % 746]!, body: "Historical notice", authorType: "system",
    });
    for (let offset = 0; offset < commentRows.length; offset += 100) {
      await db.insert(issueComments).values(commentRows.slice(offset, offset + 100));
    }
    await db.$client.unsafe("ANALYZE");
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await postgres?.cleanup();
  });

  it("keeps the exact pending set without scanning saved contexts for already-receipted comments", async () => {
    const captured: { query: string; parameters: unknown[] }[] = [];
    db.$client.options.debug = (_connection, query, parameters) => { captured.push({ query, parameters }); };
    const started = performance.now();
    const rows = await undeliveredConversationComments(db, companyId, issueId);
    const wallMs = performance.now() - started;
    db.$client.options.debug = false;
    expect(rows.map(row => row.id)).toEqual([pendingId]);
    expect(captured).toHaveLength(1);
    const { query, parameters } = captured[0]!;
    const explained = await db.$client.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters as never[]);
    const plan = explained[0]!['QUERY PLAN'][0];
    // Execution, not planning or JS time. The corresponding HTTP benchmark measures the full boundary.
    const report = {
      returnedIds: rows.map(row => row.id), wallMs,
      planningMs: plan['Planning Time'], executionMs: plan['Execution Time'],
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
    };
    console.info("outbox gate-shape", JSON.stringify(report));
    if (process.env.PAPERCLIP_OUTBOX_BENCHMARK_REPORT) {
      await writeFile(process.env.PAPERCLIP_OUTBOX_BENCHMARK_REPORT, JSON.stringify({ report, query, parameters, plan }, null, 2));
    }
    expect(plan['Execution Time'], "gate-shaped outbox statement must execute below 50 ms").toBeLessThan(50);
  }, 90_000);

  it("preserves the newer-answer floor, never-carried exception, live custody and reset boundary", async () => {
    const owed = async () => {
      const [row] = await db.select({ owed: personMessageOwedSql({
        id: sql`${issueComments.id}`, companyId: sql`${issueComments.companyId}`,
        issueId: sql`${issueComments.issueId}`, createdAt: sql`${issueComments.createdAt}`,
      }) }).from(issueComments).where(eq(issueComments.id, pendingId));
      return row!.owed;
    };
    expect(await owed()).toBe(true);
    const newerId = randomUUID();
    await db.insert(issueComments).values({ id: newerId, companyId, issueId, body: "Later input",
      authorType: "user", authorUserId: "outbox-owner", createdAt: new Date(Date.now() + 1000) });
    // A streamed answer to a later input does not erase never-carried input.
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, status: "succeeded",
      contextSnapshot: { issueId, steeredCommentIds: [newerId], answeredSteeredCommentIds: [newerId] } });
    expect(await owed()).toBe(true);
    // A historic carrier with no reply is subject to the same move-on floor.
    await db.insert(heartbeatRuns).values({ companyId, agentId, nativeIssueId: issueId, status: "succeeded",
      contextSnapshot: { issueId, wakeCommentId: pendingId } });
    expect(await owed()).toBe(false);
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", status: "queued",
      payload: { issueId, commentId: pendingId } });
    expect(await owed()).toBe(true);
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wakeId));
    expect(await owed()).toBe(false);
    await db.update(agentWakeupRequests).set({ status: "queued" }).where(eq(agentWakeupRequests.id, wakeId));
    await db.update(issues).set({ conversationBoundaryCommentId: newerId }).where(eq(issues.id, issueId));
    expect(await owed()).toBe(false);
  }, 90_000);
});
