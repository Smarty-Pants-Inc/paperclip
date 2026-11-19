import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { answeredCarriedCommentIds, interruptedTurnUnansweredCommentIds } from "../services/interrupted-turn-input.js";
import { unansweredPersonMessageCommentCondition } from "../services/recovery/unanswered-person-message.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
// Independent RED diagnostic: compare the new answer predicate with the existing
// canonical carried-message arm on the real database, without later-input widening.
describe.skipIf(!support.supported)("judge single answer predicate parity", () => {
  let pg: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { pg = await startEmbeddedPostgresTestDatabase("judge-answer-parity-"); db = createDb(pg.connectionString); }, 90000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await pg?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), commentId = randomUUID(), runId = randomUUID();
    const t = Date.now();
    await db.insert(companies).values({ id: companyId, name: "Judge", issuePrefix: `J${companyId.slice(0,6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Judge", adapterType: "paperclip_runner", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Judge", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", body: "MSG", createdAt: new Date(t-2000) });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", startedAt: new Date(t-1500), finishedAt: new Date(t-1000),
      contextSnapshot: { issueId, commentId } });
    return { companyId, agentId, issueId, commentId, runId };
  }
  it("an exact carried commentId-only input with its run's agent reply is answered in both readers", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "agent", authorAgentId: f.agentId,
      createdByRunId: f.runId, body: "Answer MSG" });
    const unanswered = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.id, f.commentId), unansweredPersonMessageCommentCondition()));
    expect(unanswered).toEqual([]);
    expect([...(await answeredCarriedCommentIds(db, { ...f, commentIds: [f.commentId] }))]).toEqual([f.commentId]);
  });
  it("a system notice attributed to the interrupted run is NOT its agent answer and must not discard MSG", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorType: "system", createdByRunId: f.runId, body: "Execution notice" });
    const unanswered = await db.select({ id: issueComments.id }).from(issueComments).where(and(eq(issueComments.id, f.commentId), unansweredPersonMessageCommentCondition()));
    expect(unanswered).toEqual([{ id: f.commentId }]);
    expect(await interruptedTurnUnansweredCommentIds(db, { ...f, run: { id: f.runId, contextSnapshot: { commentId: f.commentId, wakeCommentIds: [f.commentId] } }, held: [] })).toEqual([f.commentId]);
  });
});
